import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { loadMigrationConfig } from "../config/load-config.js";
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
        await client.query(sql);
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

async function main(): Promise<void> {
  const config = loadMigrationConfig(process.env);
  const pool = new Pool({ connectionString: config.migrationDatabaseUrl });
  try {
    await migrate(pool, { expectedChecksum: config.migrationSha256 });
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
