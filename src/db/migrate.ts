import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { loadAdminConfig, loadMigrationConfig } from "../config/load-config.js";
import { loadMigrations, type LoadedMigration } from "./migration-manifest.js";
import { assertCatalogIsAbsentOrComplete } from "./schema-manifest.js";

export interface MigrationOptions {
  /** Compatibility guard for the published 0001 migration checksum. */
  expectedChecksum: string;
  /** Test-only override for the published 0001 migration. */
  sqlOverride?: string;
}

const historyTable = "ace_hunter.schema_migrations";

async function ensureHistoryTable(client: PoolClient): Promise<void> {
  await client.query("set local role ace_hunter_owner");
  await client.query(
    `create table if not exists ${historyTable} (
       id text primary key,
       checksum text not null,
       applied_at timestamptz not null default now()
     )`,
  );
}

async function appliedMigrations(client: PoolClient): Promise<Map<string, string>> {
  const result = await client.query<{ id: string; checksum: string }>(
    `select id,checksum from ${historyTable} order by id`,
  );
  return new Map(result.rows.map((row) => [row.id, row.checksum]));
}

function assertExpectedInitialChecksum(migrations: readonly LoadedMigration[], expectedChecksum: string): void {
  const initial = migrations[0];
  if (!initial || initial.checksum !== expectedChecksum) {
    throw new Error(
      `migration checksum mismatch: expected ${expectedChecksum} actual ${initial?.checksum ?? "missing"}`,
    );
  }
}

function assertAppliedChecksums(
  applied: ReadonlyMap<string, string>,
  migrations: readonly LoadedMigration[],
): void {
  for (const [index, migration] of migrations.entries()) {
    const recorded = applied.get(migration.id);
    if (recorded !== undefined && recorded !== migration.checksum) {
      throw new Error(
        `applied migration checksum mismatch: ${migration.id} expected ${migration.checksum} actual ${recorded}`,
      );
    }
    if (recorded !== undefined && migrations.slice(0, index).some((prior) => !applied.has(prior.id))) {
      throw new Error(`migration history is out of order: ${migration.id}`);
    }
  }
}

async function recordMigration(client: PoolClient, migration: LoadedMigration): Promise<void> {
  await client.query(`insert into ${historyTable}(id,checksum) values($1,$2)`, [
    migration.id,
    migration.checksum,
  ]);
}

async function applyMigrations(
  client: PoolClient,
  migrations: readonly LoadedMigration[],
  applyInitial: (sql: string) => Promise<void>,
): Promise<void> {
  const state = await assertCatalogIsAbsentOrComplete(client);
  await client.query("begin");
  try {
    await ensureHistoryTable(client);
    const applied = await appliedMigrations(client);
    assertAppliedChecksums(applied, migrations);

    if (state === "complete" && !applied.has(migrations[0]!.id)) {
      await recordMigration(client, migrations[0]!);
    }

    for (const migration of migrations) {
      if (applied.has(migration.id) || (state === "complete" && migration === migrations[0])) {
        continue;
      }
      if (migration === migrations[0]) await applyInitial(migration.sql);
      else await client.query(migration.sql);
      if (migration === migrations[0]) {
        const completedState = await assertCatalogIsAbsentOrComplete(client);
        if (completedState !== "complete") {
          throw new Error("catalog preflight failed: migration did not complete");
        }
      }
      await recordMigration(client, migration);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

export async function migrate(pool: Pool, options: MigrationOptions): Promise<void> {
  const migrations = await loadMigrations(options.sqlOverride);
  assertExpectedInitialChecksum(migrations, options.expectedChecksum);
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('ace_hunter:migrate'))");
    await applyMigrations(client, migrations, async (sql) => {
      await client.query("set local role ace_hunter_owner");
      await client.query(sql);
    });
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('ace_hunter:migrate'))").catch(() => undefined);
    client.release();
  }
}

/** Runs 0001 with Supabase's restricted auth-FK workaround; later migrations stay ordinary. */
export async function migrateWithRestrictedAdmin(pool: Pool, options: MigrationOptions): Promise<void> {
  const migrations = await loadMigrations(options.sqlOverride);
  assertExpectedInitialChecksum(migrations, options.expectedChecksum);
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('ace_hunter:migrate'))");
    await applyMigrations(client, migrations, async (sql) => {
      await client.query(`do $ace_admin_membership$ begin execute format('grant ace_hunter_owner to %I',current_user); end $ace_admin_membership$`);
      const authConstraints = [
        "  constraint user_product_monitors_user_id_fkey foreign key (user_id)\n    references auth.users(id) on delete cascade,\n",
        "  constraint analysis_outputs_user_id_fkey foreign key (user_id)\n    references auth.users(id) on delete set null,\n",
      ];
      let ownerSql = sql;
      for (const constraint of authConstraints) {
        if (!ownerSql.includes(constraint)) throw new Error("reviewed auth foreign key migration shape changed");
        ownerSql = ownerSql.replace(constraint, "");
      }
      await client.query("set local role ace_hunter_owner");
      await client.query(ownerSql);
      await client.query("reset role");
      await client.query("alter table ace_hunter.user_product_monitors add constraint user_product_monitors_user_id_fkey foreign key(user_id) references auth.users(id) on delete cascade");
      await client.query("alter table ace_hunter.analysis_outputs add constraint analysis_outputs_user_id_fkey foreign key(user_id) references auth.users(id) on delete set null");
      await client.query(`do $ace_admin_membership$ begin execute format('revoke ace_hunter_owner from %I',current_user); end $ace_admin_membership$`);
    });
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('ace_hunter:migrate'))").catch(() => undefined);
    client.release();
  }
}

async function main(): Promise<void> {
  const config = loadMigrationConfig(process.env);
  const pool = new Pool({ connectionString: config.migrationDatabaseUrl });
  try {
    const capability = await pool.query<{ allowed: boolean }>(
      `select exists(select 1 from pg_namespace n cross join lateral aclexplode(n.nspacl) a join pg_roles r on r.oid=a.grantee where n.nspname='auth' and r.rolname='ace_hunter_owner' and a.privilege_type='USAGE') and exists(select 1 from pg_attribute col join pg_class c on c.oid=col.attrelid join pg_namespace n on n.oid=c.relnamespace cross join lateral aclexplode(col.attacl) a join pg_roles r on r.oid=a.grantee where n.nspname='auth' and c.relname='users' and col.attname='id' and r.rolname='ace_hunter_owner' and a.privilege_type='REFERENCES') allowed`,
    );
    if (capability.rows[0]?.allowed) await migrate(pool, { expectedChecksum: config.migrationSha256 });
    else {
      const admin = new Pool({ connectionString: loadAdminConfig(process.env).adminDatabaseUrl });
      try { await migrateWithRestrictedAdmin(admin, { expectedChecksum: config.migrationSha256 }); }
      finally { await admin.end(); }
    }
  } finally { await pool.end(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
