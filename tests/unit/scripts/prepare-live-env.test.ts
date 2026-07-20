import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRoleUrl,
  createFileCredentialStore,
  fixedRoleCredentials,
  parseSourceDotenv,
  serializeDotenv,
  setFixedRolePassword,
} from "../../../scripts/prepare-live-env.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("prepare-live-env safety helpers", () => {
  it("parses dotenv assignments but rejects shell syntax", () => {
    expect(parseSourceDotenv("SUPABASE_DB_URL=postgres://host/db\n# ok\nGITHUB_TOKEN='token'\n")).toMatchObject({
      SUPABASE_DB_URL: "postgres://host/db",
      GITHUB_TOKEN: "token",
    });
    expect(() => parseSourceDotenv("SUPABASE_DB_URL=$(id)\n")).toThrow("invalid_dotenv_syntax");
    expect(() => parseSourceDotenv("source ./secrets\n")).toThrow("invalid_dotenv_syntax");
  });

  it("serializes every value with JSON quoting and no executable lines", () => {
    expect(serializeDotenv({ TOKEN: "a b#c\nnext", URL: "postgres://u:p@h/db" })).toBe(
      'TOKEN="a b#c\\nnext"\nURL="postgres://u:p@h/db"\n',
    );
  });

  it("persists fixed database credentials in an owner-only, atomic local store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ace-hunter-credential-store-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "credentials.env");
    const store = createFileCredentialStore(path);

    expect(await store.get("runtime-database-url")).toBeNull();
    await store.set("runtime-database-url", "postgres://runtime:secret@example.test/db");
    await store.set("migration-database-url", "postgres://migration:secret@example.test/db");

    expect(await store.get("runtime-database-url")).toBe("postgres://runtime:secret@example.test/db");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).not.toContain("runtime-database-url");
    await store.delete("runtime-database-url");
    expect(await store.get("runtime-database-url")).toBeNull();
  });

  it("uses URL credential fields instead of interpolating credentials", () => {
    expect(buildRoleUrl("postgres://admin:old@localhost:5432/db?sslmode=require", "ace_hunter_runtime", "p@:/?#[]")).toBe(
      "postgres://ace_hunter_runtime:p%40%3A%2F%3F%23%5B%5D@localhost:5432/db?sslmode=require",
    );
    expect(buildRoleUrl("postgres://postgres.project-ref:old@pooler.example/db", "ace_hunter_runtime", "safe")).toContain(
      "ace_hunter_runtime.project-ref:safe@pooler.example",
    );
  });

  it("quotes passwords through PostgreSQL format and fixed role allowlist", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "select format('%L', $1::text) quoted") return { rows: [{ quoted: "'safe'" }] };
      return { rows: [] };
    });
    await setFixedRolePassword({ query }, "ace_hunter_runtime", "safe");
    expect(query).toHaveBeenNthCalledWith(1, "select format('%L', $1::text) quoted", ["safe"]);
    expect(query).toHaveBeenNthCalledWith(2, "alter role ace_hunter_runtime password 'safe'");
    await expect(setFixedRolePassword({ query }, "postgres", "safe")).rejects.toThrow("role_not_allowed");
  });

  it("bootstraps only when both Keychain DSNs are absent and never overwrites", async () => {
    const stored = new Map<string, string>();
    const keychain = {
      get: vi.fn(async (account: string) => stored.get(account) ?? null),
      set: vi.fn(async (account: string, value: string) => {
        if (stored.has(account)) throw new Error("overwrite");
        stored.set(account, value);
      }),
      delete: vi.fn(async (account: string) => { stored.delete(account); }),
    };
    const admin = { query: vi.fn(async () => ({ rows: [{ quoted: "'generated'" }] })) };
    const generated = await fixedRoleCredentials({
      mode: "bootstrap",
      keychain,
      admin,
      adminUrl: "postgres://admin:secret@localhost/db",
      randomPassword: () => "generated",
    });
    expect(generated.migrationUrl).toContain("ace_hunter_migrator:generated@");
    expect(generated.runtimeUrl).toContain("ace_hunter_runtime:generated@");
    await expect(fixedRoleCredentials({ mode: "bootstrap", keychain, admin, adminUrl: "postgres://admin:secret@localhost/db" })).rejects.toThrow(
      "bootstrap_credentials_already_exist",
    );
    await expect(fixedRoleCredentials({ mode: "release", keychain: { ...keychain, get: async () => null }, admin, adminUrl: "postgres://a:b@h/db" })).rejects.toThrow(
      "fixed_credentials_required",
    );
    await expect(fixedRoleCredentials({
      mode: "release",
      keychain: { ...keychain, get: async (account: string) => account.startsWith("migration") ? "postgres://ace_hunter_migrator:p@other/db" : "postgres://ace_hunter_runtime:p@other/db" },
      admin,
      adminUrl: "postgres://admin:p@expected/db",
    })).rejects.toThrow("invalid_fixed_role_credential");
  });

  it("compensates a partial Keychain failure and disables both database logins", async () => {
    const stored = new Map<string, string>();
    let writes = 0;
    const keychain = {
      get: vi.fn(async () => null),
      set: vi.fn(async (account: string, value: string) => {
        writes += 1;
        if (writes === 2) throw new Error("injected_write_failure");
        stored.set(account, value);
      }),
      delete: vi.fn(async (account: string) => { stored.delete(account); }),
    };
    const query = vi.fn(async (sql: string) => sql.startsWith("select format")
      ? { rows: [{ quoted: "'generated'" }] }
      : { rows: [] });
    await expect(fixedRoleCredentials({
      mode: "bootstrap", keychain, admin: { query }, adminUrl: "postgres://admin:secret@localhost/db", randomPassword: () => "generated",
    })).rejects.toThrow("credential_bootstrap_failed_rolled_back");
    expect(stored.size).toBe(0);
    expect(keychain.delete).toHaveBeenCalledWith("migration-database-url");
    expect(keychain.delete).toHaveBeenCalledWith("runtime-database-url");
    expect(query).toHaveBeenCalledWith("alter role ace_hunter_migrator nologin");
    expect(query).toHaveBeenCalledWith("alter role ace_hunter_runtime nologin");
  });
});
