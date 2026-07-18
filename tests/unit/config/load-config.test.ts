import { describe, expect, it } from "vitest";
import { loadMigrationConfig, loadRuntimeConfig } from "../../../src/config/load-config.js";

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
});
