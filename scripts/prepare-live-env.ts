import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "dotenv";
import { Pool } from "pg";
import { recordAdminCatalog } from "./supabase-safety-check.js";

type Queryable = { query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };
export type Keychain = { get(account: string): Promise<string | null>; set(account: string, value: string): Promise<void>; delete(account: string): Promise<void> };
export type LiveMode = "bootstrap" | "local" | "release";
const ROLE_NAMES = new Set(["ace_hunter_migrator", "ace_hunter_runtime"]);
const KEYCHAIN_ACCOUNTS = { migration: "migration-database-url", runtime: "runtime-database-url" } as const;

export function parseSourceDotenv(source: string): Record<string, string> {
  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^(?:source|\.)\s+/i.test(line) || line.includes("$(") || line.includes("`") || /(?:^|\s)(?:&&|\|\||;)(?:\s|$)/.test(line)) {
      throw new Error("invalid_dotenv_syntax");
    }
  }
  return parse(source);
}

export function serializeDotenv(values: Record<string, string>): string {
  return Object.entries(values).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("invalid_env_key");
    return `${key}=${JSON.stringify(value)}\n`;
  }).join("");
}

export function buildRoleUrl(adminUrl: string, roleName: string, password: string): string {
  if (!ROLE_NAMES.has(roleName)) throw new Error("role_not_allowed");
  const url = new URL(adminUrl);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("postgres_url_required");
  const adminUsername = decodeURIComponent(url.username);
  const tenantSuffix = adminUsername.includes(".") ? adminUsername.slice(adminUsername.indexOf(".")) : "";
  url.username = `${roleName}${tenantSuffix}`;
  url.password = password;
  return url.toString();
}

export async function setFixedRolePassword(admin: Queryable, roleName: string, password: string): Promise<void> {
  if (!ROLE_NAMES.has(roleName)) throw new Error("role_not_allowed");
  const quoted = await admin.query("select format('%L', $1::text) quoted", [password]);
  const literal = quoted.rows[0]?.quoted;
  if (typeof literal !== "string") throw new Error("password_quote_failed");
  await admin.query(`alter role ${roleName} password ${literal}`);
}

export async function bootstrapFixedRolesAndSchema(admin: Queryable): Promise<void> {
  await admin.query(`do $ace_bootstrap$
begin
  if not exists(select 1 from pg_roles where rolname='ace_hunter_owner') then create role ace_hunter_owner; end if;
  if not exists(select 1 from pg_roles where rolname='ace_hunter_migrator') then create role ace_hunter_migrator; end if;
  if not exists(select 1 from pg_roles where rolname='ace_hunter_runtime') then create role ace_hunter_runtime; end if;
end $ace_bootstrap$`);
  // Supabase's administrator has CREATEROLE but is intentionally not a true
  // superuser. SUPERUSER/REPLICATION/BYPASSRLS clauses themselves require a
  // true superuser even when setting the negative form, so create with secure
  // defaults and alter only attributes this administrator is allowed to set.
  await admin.query("alter role ace_hunter_owner nologin nocreatedb nocreaterole noinherit");
  await admin.query("alter role ace_hunter_migrator login nocreatedb nocreaterole noinherit");
  await admin.query("alter role ace_hunter_runtime login nocreatedb nocreaterole noinherit");
  const roleSafety = await admin.query(`select count(*)::int unsafe from pg_roles
    where rolname in ('ace_hunter_owner','ace_hunter_migrator','ace_hunter_runtime')
      and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)`);
  if (roleSafety.rows[0]?.unsafe !== 0) throw new Error("unsafe_existing_ace_role_collision");
  await admin.query(`do $ace_membership$
begin
  if not pg_has_role('ace_hunter_migrator','ace_hunter_owner','member') then grant ace_hunter_owner to ace_hunter_migrator; end if;
end $ace_membership$`);
  await admin.query("grant usage on schema auth to ace_hunter_owner");
  await admin.query("grant references (id) on auth.users to ace_hunter_owner");
  await admin.query(`do $ace_schema$
begin
  execute format('grant ace_hunter_owner to %I', current_user);
  if not exists(select 1 from pg_namespace where nspname='ace_hunter') then
    create schema ace_hunter authorization ace_hunter_owner;
  else
    alter schema ace_hunter owner to ace_hunter_owner;
  end if;
  execute format('revoke ace_hunter_owner from %I', current_user);
end $ace_schema$`);
  // PostgreSQL 16 records CREATEROLE creators as implicit ADMIN members of
  // newly-created roles. They are bootstrap scaffolding, not steady-state
  // authority, so remove all three creator edges explicitly.
  await admin.query(`do $ace_creator_memberships$
begin
  execute format('revoke ace_hunter_owner from %I', current_user);
  execute format('revoke ace_hunter_migrator from %I', current_user);
  execute format('revoke ace_hunter_runtime from %I', current_user);
end $ace_creator_memberships$`);
  await admin.query("revoke all on schema ace_hunter from public");
}

export async function fixedRoleCredentials(options: {
  mode: LiveMode; keychain: Keychain; admin: Queryable; adminUrl: string; randomPassword?: () => string;
}): Promise<{ migrationUrl: string; runtimeUrl: string }> {
  const [migrationExisting, runtimeExisting] = await Promise.all([
    options.keychain.get(KEYCHAIN_ACCOUNTS.migration), options.keychain.get(KEYCHAIN_ACCOUNTS.runtime),
  ]);
  if (options.mode !== "bootstrap") {
    if (!migrationExisting || !runtimeExisting) throw new Error("fixed_credentials_required");
    validateRoleDsn(migrationExisting, "ace_hunter_migrator", options.adminUrl);
    validateRoleDsn(runtimeExisting, "ace_hunter_runtime", options.adminUrl);
    return { migrationUrl: migrationExisting, runtimeUrl: runtimeExisting };
  }
  if (migrationExisting || runtimeExisting) throw new Error("bootstrap_credentials_already_exist");
  const generate = options.randomPassword ?? (() => randomBytes(32).toString("base64url"));
  const migrationPassword = generate();
  const runtimePassword = generate();
  const migrationUrl = buildRoleUrl(options.adminUrl, "ace_hunter_migrator", migrationPassword);
  const runtimeUrl = buildRoleUrl(options.adminUrl, "ace_hunter_runtime", runtimePassword);
  try {
    await setFixedRolePassword(options.admin, "ace_hunter_migrator", migrationPassword);
    await setFixedRolePassword(options.admin, "ace_hunter_runtime", runtimePassword);
    await options.keychain.set(KEYCHAIN_ACCOUNTS.migration, migrationUrl);
    await options.keychain.set(KEYCHAIN_ACCOUNTS.runtime, runtimeUrl);
  } catch (error) {
    const recovery = await Promise.allSettled([
      options.keychain.delete(KEYCHAIN_ACCOUNTS.migration),
      options.keychain.delete(KEYCHAIN_ACCOUNTS.runtime),
      options.admin.query("alter role ace_hunter_migrator nologin"),
      options.admin.query("alter role ace_hunter_runtime nologin"),
    ]);
    if (recovery.some((result) => result.status === "rejected")) throw new Error("credential_bootstrap_rollback_failed", { cause: error });
    throw new Error("credential_bootstrap_failed_rolled_back", { cause: error });
  }
  return { migrationUrl, runtimeUrl };
}

function validateRoleDsn(value: string, expectedUser: string, adminUrl: string): void {
  const url = new URL(value);
  const admin = new URL(adminUrl);
  const username = decodeURIComponent(url.username);
  const adminUsername = decodeURIComponent(admin.username);
  const tenantSuffix = adminUsername.includes(".") ? adminUsername.slice(adminUsername.indexOf(".")) : "";
  if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") || username !== `${expectedUser}${tenantSuffix}` || !url.password ||
      url.protocol !== admin.protocol || url.hostname !== admin.hostname || url.port !== admin.port || url.pathname !== admin.pathname || url.search !== admin.search) {
    throw new Error("invalid_fixed_role_credential");
  }
}

export function createKeychainClient(helper: string): Keychain {
  if (!isAbsolute(helper)) throw new Error("absolute_keychain_helper_required");
  return {
    async get(account) {
      const result = await runHelper(helper, ["get", account]);
      if (result.code !== 0) {
        if (result.stderr.trim() === "secret_unavailable") return null;
        throw new Error("keychain_read_failed");
      }
      if (!result.stdout || result.stdout.length > 16_384 || /[\0\r\n]/.test(result.stdout)) throw new Error("invalid_keychain_value");
      return result.stdout;
    },
    async set(account, value) {
      const result = await runHelper(helper, ["set", account], value);
      if (result.code !== 0) throw new Error("keychain_write_failed");
    },
    async delete(account) {
      const result = await runHelper(helper, ["delete", account]);
      if (result.code !== 0 && result.stderr.trim() !== "secret_unavailable") throw new Error("keychain_delete_failed");
    },
  };
}

function runHelper(file: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    child.stdin.end(input);
  });
}

function requiredSource(source: Record<string, string>): { adminUrl: string; githubToken: string; deepseekKey: string; userId?: string } {
  const adminUrl = source.ACE_HUNTER_ADMIN_DATABASE_URL ?? source.SUPABASE_DB_URL;
  const githubToken = source.ACE_HUNTER_GITHUB_TOKEN ?? source.GITHUB_TOKEN;
  const deepseekKey = source.ACE_HUNTER_DEEPSEEK_API_KEY ?? source.DEEPSEEK_API_KEY;
  if (!adminUrl || !githubToken || !deepseekKey) throw new Error("required_source_alias_missing");
  const url = new URL(adminUrl);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("invalid_admin_database_url");
  return { adminUrl, githubToken, deepseekKey, userId: source.ACE_HUNTER_USER_ID };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  await access(args.source, constants.R_OK);
  await access(args.keychainHelper, constants.X_OK);
  const source = requiredSource(parseSourceDotenv(await readFile(args.source, "utf8")));
  const directory = await mkdtemp(join(tmpdir(), "ace-hunter-live-"));
  await chmod(directory, 0o700);
  const onInterrupt = () => { void rm(directory, { recursive: true, force: true }).finally(() => process.exit(130)); };
  const onTerminate = () => { void rm(directory, { recursive: true, force: true }).finally(() => process.exit(143)); };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  const fingerprintPath = join(directory, "admin-catalog.json");
  const envPath = join(directory, "runtime.env");
  const admin = new Pool({
    connectionString: source.adminUrl,
    connectionTimeoutMillis: 15_000,
    query_timeout: 120_000,
    statement_timeout: 120_000,
  });
  let completed = false;
  try {
    await recordAdminCatalog(admin, fingerprintPath);
    await bootstrapFixedRolesAndSchema(admin);
    const credentials = await fixedRoleCredentials({ mode: args.mode, keychain: createKeychainClient(args.keychainHelper), admin, adminUrl: source.adminUrl });
    const selected = source.userId
      ? await admin.query("select id from auth.users where id=$1", [source.userId])
      : await admin.query("select id from auth.users order by created_at,id limit 1");
    if (selected.rows.length !== 1 || typeof selected.rows[0]?.id !== "string") throw new Error("existing_auth_user_required");
    const migration = await readFile("src/db/migrations/0001_ace_hunter_initial.sql");
    const checksum = createHash("sha256").update(migration).digest("hex");
    await writeFile(envPath, serializeDotenv({
      ACE_HUNTER_ADMIN_DATABASE_URL: source.adminUrl,
      ACE_HUNTER_MIGRATION_DATABASE_URL: credentials.migrationUrl,
      ACE_HUNTER_RUNTIME_DATABASE_URL: credentials.runtimeUrl,
      ACE_HUNTER_MIGRATION_SHA256: checksum,
      ACE_HUNTER_USER_ID: String(selected.rows[0].id),
      ACE_HUNTER_GITHUB_TOKEN: source.githubToken,
      ACE_HUNTER_DEEPSEEK_API_KEY: source.deepseekKey,
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      DEEPSEEK_MODEL: "deepseek-chat",
      TWITTER_CLI_PATH: "twitter",
      ACE_HUNTER_ADMIN_FINGERPRINT_FILE: fingerprintPath,
    }), { mode: 0o600, flag: "wx" });
    completed = true;
    process.stdout.write(`${envPath}\n`);
  } finally {
    await admin.end();
    if (!completed) await rm(directory, { recursive: true, force: true });
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

function parseArguments(args: string[]): { mode: LiveMode; source: string; keychainHelper: string } {
  let mode: LiveMode | undefined, source: string | undefined, keychainHelper: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!value) throw new Error("usage_error");
    if (flag === "--mode" && ["bootstrap", "local", "release"].includes(value)) mode = value as LiveMode;
    else if (flag === "--source") source = value;
    else if (flag === "--keychain-helper") keychainHelper = value;
    else throw new Error("usage_error");
  }
  if (!mode || !source || !keychainHelper || !isAbsolute(source) || !isAbsolute(keychainHelper)) throw new Error("usage_error");
  return { mode, source, keychainHelper };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
