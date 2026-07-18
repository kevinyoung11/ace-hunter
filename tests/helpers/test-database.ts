import { Pool } from "pg";

const expectedDatabaseName = "ace_hunter_test";
const requiredKeys = [
  "ACE_TEST_ADMIN_DATABASE_URL",
  "ACE_TEST_MIGRATION_DATABASE_URL",
  "ACE_TEST_RUNTIME_DATABASE_URL",
] as const;

type TestDatabaseKey = (typeof requiredKeys)[number];

export interface TestDatabaseConfig {
  adminDatabaseUrl: string;
  migrationDatabaseUrl: string;
  runtimeDatabaseUrl: string;
  databaseName: typeof expectedDatabaseName;
}

export interface VerifiedTestPools {
  adminPool: Pool;
  migratorPool: Pool;
  runtimePool: Pool;
  config: TestDatabaseConfig;
}

export type TestPoolFactory = (connectionString: string) => Pool;

function parseUrl(key: TestDatabaseKey, value: string | undefined): URL {
  if (!value) throw new Error(`Missing explicit test database URL: ${key}`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid test database URL: ${key}`);
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new Error(`Invalid test database protocol: ${key}`);
  }
  if (
    parsed.pathname !== `/${expectedDatabaseName}` ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(`${key} database must be exactly ${expectedDatabaseName}`);
  }
  return parsed;
}

export function parseTestDatabaseConfig(
  env: Record<string, string | undefined>,
): TestDatabaseConfig {
  const urls = Object.fromEntries(
    requiredKeys.map((key) => [key, parseUrl(key, env[key])]),
  ) as Record<TestDatabaseKey, URL>;
  const hosts = new Set(requiredKeys.map((key) => urls[key].host));
  if (hosts.size !== 1) throw new Error("Test database URLs must use the same host");
  if (urls.ACE_TEST_MIGRATION_DATABASE_URL.username !== "ace_hunter_migrator") {
    throw new Error("Migration test URL must use ace_hunter_migrator");
  }
  if (urls.ACE_TEST_RUNTIME_DATABASE_URL.username !== "ace_hunter_runtime") {
    throw new Error("Runtime test URL must use ace_hunter_runtime");
  }
  if (urls.ACE_TEST_ADMIN_DATABASE_URL.username.startsWith("ace_hunter_")) {
    throw new Error("Admin test URL must not use an Ace Hunter role");
  }
  return {
    adminDatabaseUrl: env.ACE_TEST_ADMIN_DATABASE_URL!,
    migrationDatabaseUrl: env.ACE_TEST_MIGRATION_DATABASE_URL!,
    runtimeDatabaseUrl: env.ACE_TEST_RUNTIME_DATABASE_URL!,
    databaseName: expectedDatabaseName,
  };
}

async function verifyIdentity(
  pool: Pool,
  expectedRole: string | null,
  requireAdministrator: boolean,
): Promise<void> {
  const result = await pool.query<{
    database_name: string;
    role_name: string;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
  }>(
    `select current_database() database_name,current_user role_name,
            role.rolsuper,role.rolcreatedb,role.rolcreaterole
       from pg_roles role where role.rolname=current_user`,
  );
  const identity = result.rows[0];
  if (!identity || identity.database_name !== expectedDatabaseName) {
    throw new Error("Test database identity verification failed");
  }
  if (expectedRole !== null && identity.role_name !== expectedRole) {
    throw new Error(`Test role identity verification failed: ${expectedRole}`);
  }
  if (
    requireAdministrator &&
    (!identity.rolsuper || !identity.rolcreatedb || !identity.rolcreaterole)
  ) {
    throw new Error("Test administrator capabilities verification failed");
  }
}

export async function createVerifiedTestPools(
  env: Record<string, string | undefined>,
  poolFactory: TestPoolFactory = (connectionString) =>
    new Pool({ connectionString }),
): Promise<VerifiedTestPools> {
  const config = parseTestDatabaseConfig(env);
  const adminPool = poolFactory(config.adminDatabaseUrl);
  const migratorPool = poolFactory(config.migrationDatabaseUrl);
  const runtimePool = poolFactory(config.runtimeDatabaseUrl);
  try {
    await verifyIdentity(adminPool, null, true);
    await verifyIdentity(migratorPool, "ace_hunter_migrator", false);
    await verifyIdentity(runtimePool, "ace_hunter_runtime", false);
    return { adminPool, migratorPool, runtimePool, config };
  } catch (error) {
    await Promise.allSettled([adminPool.end(), migratorPool.end(), runtimePool.end()]);
    throw error;
  }
}
