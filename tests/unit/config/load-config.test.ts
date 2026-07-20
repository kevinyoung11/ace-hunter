import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadMigrationConfig,
  loadReadonlyRuntimeConfig,
  loadRuntimeConfig,
} from "../../../src/config/load-config.js";

const valid = {
  ACE_HUNTER_MIGRATION_DATABASE_URL: "postgres://admin:secret@localhost:5432/ace_test",
  ACE_HUNTER_MIGRATION_SHA256: "a".repeat(64),
  ACE_HUNTER_RUNTIME_DATABASE_URL: "postgres://ace:secret@localhost:5432/ace_test",
  ACE_HUNTER_GITHUB_TOKEN: "github-secret",
  ACE_HUNTER_USER_ID: "5d991d19-d5e2-45e8-a8f9-724957aa2137",
};

describe("loadConfig", () => {
  it("parses the required server configuration", () => {
    expect(loadRuntimeConfig(valid)).toMatchObject({
      githubToken: "github-secret",
      runtimeDatabaseUrl: valid.ACE_HUNTER_RUNTIME_DATABASE_URL,
    });
    expect(
      loadMigrationConfig({
        ACE_HUNTER_MIGRATION_DATABASE_URL: valid.ACE_HUNTER_MIGRATION_DATABASE_URL,
        ACE_HUNTER_MIGRATION_SHA256: valid.ACE_HUNTER_MIGRATION_SHA256,
      }),
    ).toEqual({
      migrationDatabaseUrl: valid.ACE_HUNTER_MIGRATION_DATABASE_URL,
      migrationSha256: valid.ACE_HUNTER_MIGRATION_SHA256,
    });
  });

  it("reports a missing key without echoing any secret", () => {
    expect(() =>
      loadRuntimeConfig({ ...valid, ACE_HUNTER_RUNTIME_DATABASE_URL: undefined }),
    ).toThrow(/ACE_HUNTER_RUNTIME_DATABASE_URL/);
    expect(() =>
      loadRuntimeConfig({ ...valid, ACE_HUNTER_RUNTIME_DATABASE_URL: undefined }),
    ).not.toThrow(/github-secret/);
    expect(() => loadMigrationConfig(valid)).not.toThrow();
  });

  it("loads read-only commands with only the runtime database URL", () => {
    expect(loadReadonlyRuntimeConfig({
      ACE_HUNTER_RUNTIME_DATABASE_URL: valid.ACE_HUNTER_RUNTIME_DATABASE_URL,
    })).toEqual({ runtimeDatabaseUrl: valid.ACE_HUNTER_RUNTIME_DATABASE_URL });
    expect(() => loadReadonlyRuntimeConfig({})).toThrow(/ACE_HUNTER_RUNTIME_DATABASE_URL/);
  });

  it("does not enumerate or access unrelated properties for read-only configuration", () => {
    const accessed: PropertyKey[] = [];
    const target = {
      ACE_HUNTER_RUNTIME_DATABASE_URL: valid.ACE_HUNTER_RUNTIME_DATABASE_URL,
      ACE_HUNTER_GITHUB_TOKEN: "must-not-be-read",
      ACE_HUNTER_USER_ID: "must-not-be-read",
      TWITTER_CLI_PATH: "must-not-be-read",
      ACE_HUNTER_DEEPSEEK_API_KEY: "must-not-be-read",
    };
    const env = new Proxy(target, {
      get(object, property, receiver) {
        accessed.push(property);
        if (property !== "ACE_HUNTER_RUNTIME_DATABASE_URL") throw new Error(`forbidden_get:${String(property)}`);
        return Reflect.get(object, property, receiver);
      },
      ownKeys() {
        throw new Error("forbidden_environment_enumeration");
      },
    });

    expect(loadReadonlyRuntimeConfig(env)).toEqual({
      runtimeDatabaseUrl: valid.ACE_HUNTER_RUNTIME_DATABASE_URL,
    });
    expect(accessed).toEqual(["ACE_HUNTER_RUNTIME_DATABASE_URL"]);
  });

  it("extracts only the database URL from a shared env file and never leaks other values", () => {
    const directory = mkdtempSync(join(tmpdir(), "ace-hunter-readonly-config-"));
    const envPath = join(directory, "runtime.env");
    const sentinel = "other-secret-must-not-leak";
    writeFileSync(envPath, [
      `ACE_HUNTER_GITHUB_TOKEN="${sentinel}`,
      `ACE_HUNTER_RUNTIME_DATABASE_URL=${valid.ACE_HUNTER_RUNTIME_DATABASE_URL}`,
      `ACE_HUNTER_USER_ID=${sentinel}`,
      `TWITTER_CLI_PATH=${sentinel}`,
      `ACE_HUNTER_DEEPSEEK_API_KEY=${sentinel}`,
    ].join("\n"), { mode: 0o600 });
    try {
      expect(loadReadonlyRuntimeConfig({ ACE_HUNTER_ENV_FILE: envPath })).toEqual({
        runtimeDatabaseUrl: valid.ACE_HUNTER_RUNTIME_DATABASE_URL,
      });
      writeFileSync(envPath, [
        `ACE_HUNTER_GITHUB_TOKEN="${sentinel}`,
        "ACE_HUNTER_RUNTIME_DATABASE_URL=not-a-url",
      ].join("\n"), { mode: 0o600 });
      expect(() => loadReadonlyRuntimeConfig({ ACE_HUNTER_ENV_FILE: envPath })).toThrow(
        /ACE_HUNTER_RUNTIME_DATABASE_URL/,
      );
      expect(() => loadReadonlyRuntimeConfig({ ACE_HUNTER_ENV_FILE: envPath })).not.toThrow(
        new RegExp(sentinel),
      );
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it("loads a strict dotenv file while defined process values take precedence", () => {
    const directory = mkdtempSync(join(tmpdir(), "ace-hunter-config-"));
    const envPath = join(directory, "runtime.env");
    writeFileSync(
      envPath,
      [
        `ACE_HUNTER_RUNTIME_DATABASE_URL=${valid.ACE_HUNTER_RUNTIME_DATABASE_URL}`,
        "ACE_HUNTER_GITHUB_TOKEN=file-token",
        `ACE_HUNTER_USER_ID=${valid.ACE_HUNTER_USER_ID}`,
      ].join("\n"),
      { mode: 0o600 },
    );

    try {
      expect(
        loadRuntimeConfig({
          ACE_HUNTER_ENV_FILE: envPath,
          ACE_HUNTER_RUNTIME_DATABASE_URL: undefined,
          ACE_HUNTER_GITHUB_TOKEN: "process-token",
        }),
      ).toMatchObject({
        runtimeDatabaseUrl: valid.ACE_HUNTER_RUNTIME_DATABASE_URL,
        githubToken: "process-token",
      });
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it("rejects malformed dotenv syntax instead of silently ignoring it", () => {
    const directory = mkdtempSync(join(tmpdir(), "ace-hunter-config-"));
    const envPath = join(directory, "runtime.env");
    writeFileSync(envPath, "THIS IS NOT DOTENV\n", { mode: 0o600 });
    try {
      expect(() => loadRuntimeConfig({ ACE_HUNTER_ENV_FILE: envPath })).toThrow(
        /Invalid dotenv syntax/,
      );
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it("accepts quoted dotenv values with inline comments", () => {
    const directory = mkdtempSync(join(tmpdir(), "ace-hunter-config-"));
    const envPath = join(directory, "runtime.env");
    writeFileSync(
      envPath,
      [
        `ACE_HUNTER_RUNTIME_DATABASE_URL="${valid.ACE_HUNTER_RUNTIME_DATABASE_URL}" # database`,
        'ACE_HUNTER_GITHUB_TOKEN="file-token" # token',
        `ACE_HUNTER_USER_ID='${valid.ACE_HUNTER_USER_ID}' # user`,
      ].join("\n"),
      { mode: 0o600 },
    );
    try {
      expect(loadRuntimeConfig({ ACE_HUNTER_ENV_FILE: envPath })).toMatchObject({
        runtimeDatabaseUrl: valid.ACE_HUNTER_RUNTIME_DATABASE_URL,
        githubToken: "file-token",
      });
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it.each(['"unterminated', "'unterminated", "`unterminated", '"ok" trailing'])(
    "rejects malformed quoted dotenv value %s",
    (malformedToken) => {
      const directory = mkdtempSync(join(tmpdir(), "ace-hunter-config-"));
      const envPath = join(directory, "runtime.env");
      writeFileSync(
        envPath,
        [
          `ACE_HUNTER_RUNTIME_DATABASE_URL=${valid.ACE_HUNTER_RUNTIME_DATABASE_URL}`,
          `ACE_HUNTER_GITHUB_TOKEN=${malformedToken}`,
          `ACE_HUNTER_USER_ID=${valid.ACE_HUNTER_USER_ID}`,
        ].join("\n"),
        { mode: 0o600 },
      );
      try {
        expect(() => loadRuntimeConfig({ ACE_HUNTER_ENV_FILE: envPath })).toThrow(
          /Invalid dotenv syntax/,
        );
      } finally {
        rmSync(directory, { recursive: true });
      }
    },
  );
});
