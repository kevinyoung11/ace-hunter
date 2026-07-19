import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { loadRuntimeConfig } from "../src/config/load-config.js";

type Queryable = { query(sql: string): Promise<unknown> };

export async function verifyRuntimePermissions(pool: Queryable): Promise<void> {
  await pool.query("select count(*) from ace_hunter.products");
  await pool.query("begin");
  try {
    await pool.query("insert into ace_hunter.products(name,status) values('permission-probe','active')");
  } finally {
    await pool.query("rollback");
  }
  for (const sql of [
    "create schema runtime_escape",
    "create table public.runtime_escape(id int)",
    "select * from auth.users",
    "alter table ace_hunter.products disable row level security",
    "set role ace_hunter_migrator",
  ]) await requirePrivilegeDenied(pool, sql);
}

async function requirePrivilegeDenied(pool: Queryable, sql: string): Promise<void> {
  await pool.query("begin");
  try {
    await pool.query(sql);
  } catch (error) {
    await pool.query("rollback");
    if (typeof error === "object" && error !== null && "code" in error && error.code === "42501") return;
    throw new Error("permission_probe_failed_for_unexpected_reason", { cause: error });
  }
  await pool.query("rollback");
  throw new Error(`unexpectedly_allowed:${sql}`);
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: loadRuntimeConfig(process.env).runtimeDatabaseUrl });
  try {
    await verifyRuntimePermissions(pool);
    process.stdout.write("runtime permission matrix passed\n");
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
