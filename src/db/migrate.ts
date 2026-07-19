import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { loadAdminConfig, loadMigrationConfig } from "../config/load-config.js";
import { assertCatalogIsAbsentOrComplete } from "./schema-manifest.js";

export interface MigrationOptions {
  expectedChecksum: string;
  sqlOverride?: string;
}

export async function migrate(pool: Pool, options: MigrationOptions): Promise<void> {
  const migrationPath = fileURLToPath(
    new URL("./migrations/0001_ace_hunter_initial.sql", import.meta.url),
  );
  const sql = options.sqlOverride ?? (await readFile(migrationPath, "utf8"));
  const actualChecksum = createHash("sha256").update(sql).digest("hex");
  if (actualChecksum !== options.expectedChecksum) {
    throw new Error(
      `migration checksum mismatch: expected ${options.expectedChecksum} actual ${actualChecksum}`,
    );
  }

  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('ace_hunter:migrate'))");
    const state = await assertCatalogIsAbsentOrComplete(client);
    if (state === "empty") {
      try {
        await client.query("begin");
        await client.query("set local role ace_hunter_owner");
        await client.query(sql);
        const completedState = await assertCatalogIsAbsentOrComplete(client);
        if (completedState !== "complete") {
          throw new Error("catalog preflight failed: migration did not complete");
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      }
    }
  } finally {
    await client
      .query("select pg_advisory_unlock(hashtext('ace_hunter:migrate'))")
      .catch(() => undefined);
    client.release();
  }
}

/**
 * Supabase no longer lets its `postgres` login delegate privileges owned by
 * `supabase_admin` on `auth`. In that deployment only, run the same reviewed
 * migration in one administrator transaction, immediately transfer every Ace
 * object to the owner role (the SQL does this), and remove the administrator's
 * temporary owner membership before catalog verification and commit.
 */
export async function migrateWithRestrictedAdmin(pool: Pool, options: MigrationOptions): Promise<void> {
  const migrationPath = fileURLToPath(new URL("./migrations/0001_ace_hunter_initial.sql", import.meta.url));
  const sql = options.sqlOverride ?? (await readFile(migrationPath, "utf8"));
  const actualChecksum = createHash("sha256").update(sql).digest("hex");
  if (actualChecksum !== options.expectedChecksum) throw new Error(`migration checksum mismatch: expected ${options.expectedChecksum} actual ${actualChecksum}`);
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('ace_hunter:migrate'))");
    const state = await assertCatalogIsAbsentOrComplete(client);
    if (state === "empty") {
      try {
        await client.query("begin");
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
        await client.query(`alter table ace_hunter.user_product_monitors add constraint user_product_monitors_user_id_fkey foreign key(user_id) references auth.users(id) on delete cascade`);
        await client.query(`alter table ace_hunter.analysis_outputs add constraint analysis_outputs_user_id_fkey foreign key(user_id) references auth.users(id) on delete set null`);
        await client.query(`do $ace_admin_membership$ begin execute format('revoke ace_hunter_owner from %I',current_user); end $ace_admin_membership$`);
        const completedState = await assertCatalogIsAbsentOrComplete(client);
        if (completedState !== "complete") throw new Error("catalog preflight failed: migration did not complete");
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      }
    }
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
      `select exists(
         select 1 from pg_namespace n cross join lateral aclexplode(n.nspacl) a
         join pg_roles r on r.oid=a.grantee
         where n.nspname='auth' and r.rolname='ace_hunter_owner' and a.privilege_type='USAGE'
       ) and exists(
         select 1 from pg_attribute col join pg_class c on c.oid=col.attrelid
         join pg_namespace n on n.oid=c.relnamespace cross join lateral aclexplode(col.attacl) a
         join pg_roles r on r.oid=a.grantee
         where n.nspname='auth' and c.relname='users' and col.attname='id'
           and r.rolname='ace_hunter_owner' and a.privilege_type='REFERENCES'
       ) allowed`,
    );
    if (capability.rows[0]?.allowed) await migrate(pool, { expectedChecksum: config.migrationSha256 });
    else {
      const admin = new Pool({ connectionString: loadAdminConfig(process.env).adminDatabaseUrl });
      try { await migrateWithRestrictedAdmin(admin, { expectedChecksum: config.migrationSha256 }); }
      finally { await admin.end(); }
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
