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
  expect(() =>
    parseTestDatabaseConfig({
      ACE_TEST_ADMIN_DATABASE_URL: "postgres://admin@db.example/ace_hunter_test",
      ACE_TEST_MIGRATION_DATABASE_URL:
        "postgres://ace_hunter_migrator:test@db.example/ace_hunter_test",
      ACE_TEST_RUNTIME_DATABASE_URL:
        "postgres://ace_hunter_runtime:test@db.example/ace_hunter_test",
    }),
  ).toThrow(/loopback/);
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

it("accepts a Docker bridge server address after literal loopback URL validation", async () => {
  const end = vi.fn().mockResolvedValue(undefined);
  const identities = [
    { role_name: "postgres", rolsuper: true, rolcreatedb: true, rolcreaterole: true },
    { role_name: "ace_hunter_migrator", rolsuper: false, rolcreatedb: false, rolcreaterole: false },
    { role_name: "ace_hunter_runtime", rolsuper: false, rolcreatedb: false, rolcreaterole: false },
  ];
  const poolFactory = vi.fn(() => {
    const identity = identities.shift()!;
    return {
      query: vi.fn().mockResolvedValue({
        rows: [{
          database_name: "ace_hunter_test",
          server_address: "172.17.0.2",
          ...identity,
        }],
      }),
      end,
    };
  });

  await expect(createVerifiedTestPools(valid, poolFactory as never)).resolves.toMatchObject({
    config: { databaseName: "ace_hunter_test" },
  });
  expect(poolFactory).toHaveBeenCalledTimes(3);
});
