import { afterAll, beforeAll, expect, it } from "vitest";
import { Pool } from "pg";
import {
  assertAceSchemaOwner,
  assertCatalogEqualExceptAceRoles,
  captureAdminCatalog,
} from "../../../scripts/supabase-safety-check.js";
import { verifyRuntimePermissions } from "../../../scripts/runtime-permission-check.js";
import { createVerifiedTestPools, parseTestDatabaseConfig } from "../../helpers/test-database.js";

const config = parseTestDatabaseConfig(process.env);
let adminPool: Pool;
let runtimePool: Pool;
let migratorPool: Pool;

beforeAll(async () => {
  ({ adminPool, runtimePool, migratorPool } = await createVerifiedTestPools({
    ACE_TEST_ADMIN_DATABASE_URL: config.adminDatabaseUrl,
    ACE_TEST_MIGRATION_DATABASE_URL: config.migrationDatabaseUrl,
    ACE_TEST_RUNTIME_DATABASE_URL: config.runtimeDatabaseUrl,
  }));
});

afterAll(async () => { await Promise.all([adminPool.end(), runtimePool.end(), migratorPool.end()]); });

it("captures a complete structured administrator catalog with the exact Ace delta", async () => {
  const catalog = await captureAdminCatalog(adminPool);
  expect(Object.keys(catalog)).toEqual(expect.arrayContaining([
    "schemas", "relations", "columns", "constraints", "indexes", "policies", "routines",
    "triggers", "types", "roles", "memberships", "schema_grants", "relation_grants", "column_grants",
  ]));
  expect(() => assertCatalogEqualExceptAceRoles(catalog, catalog)).not.toThrow();
  await expect(assertAceSchemaOwner(adminPool)).resolves.toBeUndefined();
});

it("allows Ace data access while denying every runtime privilege escape", async () => {
  await expect(verifyRuntimePermissions(runtimePool)).resolves.toBeUndefined();
});
