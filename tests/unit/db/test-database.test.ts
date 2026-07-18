import { expect, it, vi } from "vitest";
import {
  createVerifiedTestPools,
  parseTestDatabaseConfig,
} from "../../helpers/test-database.js";

const valid = {
  ACE_TEST_ADMIN_DATABASE_URL: "postgres://localhost/ace_hunter_test",
  ACE_TEST_MIGRATION_DATABASE_URL:
    "postgres://ace_hunter_migrator:test@localhost/ace_hunter_test",
  ACE_TEST_RUNTIME_DATABASE_URL:
    "postgres://ace_hunter_runtime:test@localhost/ace_hunter_test",
};

it("requires three explicit same-host URLs for exactly ace_hunter_test", () => {
  expect(parseTestDatabaseConfig(valid)).toMatchObject({
    databaseName: "ace_hunter_test",
  });
  expect(() =>
    parseTestDatabaseConfig({ ...valid, ACE_TEST_ADMIN_DATABASE_URL: undefined }),
  ).toThrow(/ACE_TEST_ADMIN_DATABASE_URL/);
  expect(() =>
    parseTestDatabaseConfig({
      ...valid,
      ACE_TEST_RUNTIME_DATABASE_URL:
        "postgres://ace_hunter_runtime:test@localhost/other_database",
    }),
  ).toThrow(/exactly ace_hunter_test/);
  expect(() =>
    parseTestDatabaseConfig({
      ...valid,
      ACE_TEST_RUNTIME_DATABASE_URL:
        "postgres://ace_hunter_runtime:test@elsewhere/ace_hunter_test",
    }),
  ).toThrow(/same host/);
});

it("does not create any Pool before configuration validation", async () => {
  const poolFactory = vi.fn();
  await expect(
    createVerifiedTestPools(
      { ...valid, ACE_TEST_MIGRATION_DATABASE_URL: undefined },
      poolFactory,
    ),
  ).rejects.toThrow(/ACE_TEST_MIGRATION_DATABASE_URL/);
  expect(poolFactory).not.toHaveBeenCalled();
});
