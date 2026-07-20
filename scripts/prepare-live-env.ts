import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "dotenv";
import { Pool } from "pg";
import { recordAdminCatalog } from "./supabase-safety-check.js";
import { verifyRuntimeCredential } from "./verify-runtime-credential.js";

type Queryable = { query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };
export type CredentialStore = { get(account: string): Promise<string | null>; set(account: string, value: string): Promise<void>; delete(account: string): Promise<void>; setPair?: (migrationUrl: string, runtimeUrl: string) => Promise<void> };
export type LiveMode = "bootstrap" | "local" | "release";
const ROLE_NAMES = new Set(["ace_hunter_migrator", "ace_hunter_runtime"]);
const KEYCHAIN_ACCOUNTS = { migration: "migration-database-url", runtime: "runtime-database-url" } as const;
const STORE_KEYS = {
  "migration-database-url": "ACE_HUNTER_MIGRATION_DATABASE_URL",
  "runtime-database-url": "ACE_HUNTER_RUNTIME_DATABASE_URL",
} as const;

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
  mode: LiveMode; keychain: CredentialStore; admin: Queryable; adminUrl: string; randomPassword?: () => string;
}): Promise<{ migrationUrl: string; runtimeUrl: string }> {
  const [migrationExisting, runtimeExisting] = await Promise.all([
    options.keychain.get(KEYCHAIN_ACCOUNTS.migration), options.keychain.get(KEYCHAIN_ACCOUNTS.runtime),
  ]);
  if (options.mode !== "bootstrap") {
    if (!migrationExisting || !runtimeExisting) throw new Error("fixed_credentials_required");
    try {
      validateRoleDsn(migrationExisting, "ace_hunter_migrator", options.adminUrl);
      validateRoleDsn(runtimeExisting, "ace_hunter_runtime", options.adminUrl);
      await verifyRuntimeCredential(migrationExisting);
      await verifyRuntimeCredential(runtimeExisting);
    } catch (error) {
      if (error instanceof Error && ["fixed_credentials_required", "invalid_fixed_role_credential"].includes(error.message)) throw error;
      throw new Error("database_credential_invalid");
    }
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

export async function recoverFixedRoleCredentials(options: {
  keychain: CredentialStore;
  admin: Queryable;
  adminUrl: string;
  migrationUrl: string;
  runtimeUrl: string;
  verify?: (url: string) => Promise<void>;
}): Promise<{ migrationUrl: string; runtimeUrl: string }> {
  try {
    validateRoleDsn(options.migrationUrl, "ace_hunter_migrator", options.adminUrl);
    validateRoleDsn(options.runtimeUrl, "ace_hunter_runtime", options.adminUrl);
    const verify = options.verify ?? verifyRuntimeCredential;
    await verify(options.migrationUrl);
    await verify(options.runtimeUrl);
    const previousMigration = await options.keychain.get(KEYCHAIN_ACCOUNTS.migration);
    if (options.keychain.setPair) await options.keychain.setPair(options.migrationUrl, options.runtimeUrl);
    else {
      await options.keychain.set(KEYCHAIN_ACCOUNTS.migration, options.migrationUrl);
      try { await options.keychain.set(KEYCHAIN_ACCOUNTS.runtime, options.runtimeUrl); }
      catch (error) { if (previousMigration) await options.keychain.set(KEYCHAIN_ACCOUNTS.migration, previousMigration); throw error; }
    }
    return { migrationUrl: options.migrationUrl, runtimeUrl: options.runtimeUrl };
  } catch (error) {
    if (error instanceof Error && error.message === "database_credential_recovery_required") throw error;
    throw new Error("database_credential_recovery_required");
  }
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

export function createKeychainClient(helper: string): CredentialStore {
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

/**
 * A non-interactive, owner-only store for the two fixed database role DSNs.
 * It deliberately stores only the database role credentials; the deploy source
 * remains the source for API credentials and the runtime env is generated
 * separately.  This prevents a login Keychain state from gating launchd.
 */
export function createFileCredentialStore(path: string): CredentialStore {
  if (!isAbsolute(path)) throw new Error("absolute_credential_store_required");
  const read = async (): Promise<Record<string, string>> => {
    const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (entry === null) return {};
    if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0) {
      throw new Error("credential_store_permissions_invalid");
    }
    const values = parseSourceDotenv(await readFile(path, "utf8"));
    for (const key of Object.keys(values)) if (!Object.values(STORE_KEYS).includes(key as never)) throw new Error("credential_store_key_invalid");
    return values;
  };
  const write = async (values: Record<string, string>): Promise<void> => {
    const directory = dirname(path);
    const temporary = join(directory, `.${randomBytes(16).toString("hex")}.credentials`);
    try {
      await writeFile(temporary, serializeDotenv(values), { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  };
  return {
    async get(account) {
      const key = STORE_KEYS[account as keyof typeof STORE_KEYS];
      if (!key) throw new Error("credential_account_not_allowed");
      return (await read())[key] ?? null;
    },
    async set(account, value) {
      const key = STORE_KEYS[account as keyof typeof STORE_KEYS];
      if (!key) throw new Error("credential_account_not_allowed");
      const values = await read();
      values[key] = value;
      await write(values);
    },
    async delete(account) {
      const key = STORE_KEYS[account as keyof typeof STORE_KEYS];
      if (!key) throw new Error("credential_account_not_allowed");
      const values = await read();
      delete values[key];
      await write(values);
    },
    async setPair(migrationUrl, runtimeUrl) {
      await write({
        [STORE_KEYS[KEYCHAIN_ACCOUNTS.migration]]: migrationUrl,
        [STORE_KEYS[KEYCHAIN_ACCOUNTS.runtime]]: runtimeUrl,
      });
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
    const credentials = await fixedRoleCredentials({ mode: args.mode, keychain: createFileCredentialStore(args.credentialStore), admin, adminUrl: source.adminUrl });
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

function parseArguments(args: string[]): { mode: LiveMode; source: string; credentialStore: string } {
  let mode: LiveMode | undefined, source: string | undefined, credentialStore: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!value) throw new Error("usage_error");
    if (flag === "--mode" && ["bootstrap", "local", "release"].includes(value)) mode = value as LiveMode;
    else if (flag === "--source") source = value;
    else if (flag === "--credential-store") credentialStore = value;
    else throw new Error("usage_error");
  }
  if (!mode || !source || !credentialStore || !isAbsolute(source) || !isAbsolute(credentialStore)) throw new Error("usage_error");
  return { mode, source, credentialStore };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
