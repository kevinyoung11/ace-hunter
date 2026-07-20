import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { migrate } from "../../../src/db/migrate.js";
import { createVerifiedTestPools, parseTestDatabaseConfig } from "../../helpers/test-database.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const config = parseTestDatabaseConfig(process.env);
let admin: Pool; let migrator: Pool; let runtime: Pool;
const checksum = createHash("sha256").update(readFileSync("src/db/migrations/0001_ace_hunter_initial.sql")).digest("hex");

beforeAll(async () => {
  ({ adminPool: admin, migratorPool: migrator, runtimePool: runtime } = await createVerifiedTestPools({ ACE_TEST_ADMIN_DATABASE_URL: config.adminDatabaseUrl, ACE_TEST_MIGRATION_DATABASE_URL: config.migrationDatabaseUrl, ACE_TEST_RUNTIME_DATABASE_URL: config.runtimeDatabaseUrl }));
  await admin.query("drop schema if exists ace_hunter cascade; create schema ace_hunter authorization ace_hunter_owner");
  await migrate(migrator, { expectedChecksum: checksum });
});
afterAll(async () => { await Promise.all([admin.end(), migrator.end(), runtime.end()]); });

describe("ops control-plane permissions", () => {
  it("installs four control tables, nine jobs, and definer functions", async () => {
    const tables = await admin.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema='ace_hunter' and table_name in ('job_definitions','job_commands','worker_heartbeats','ops_audit_log') order by 1");
    expect(tables.rows.map((r) => r.table_name)).toEqual(["job_commands", "job_definitions", "ops_audit_log", "worker_heartbeats"]);
    expect((await admin.query("select count(*)::int count from ace_hunter.job_definitions")).rows[0].count).toBe(9);
    const funcs = await admin.query<{ proname: string; prosecdef: boolean }>("select proname,prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='ace_hunter' and proname in ('claim_job_command','start_job_command','bind_job_run','complete_job_command','cancel_job_command','requeue_job_command','heartbeat_worker') order by 1");
    expect(funcs.rows).toHaveLength(7); expect(funcs.rows.every((r) => r.prosecdef)).toBe(true);
  });
  it("does not expose direct control-table CRUD to runtime", async () => {
    await expect(runtime.query("select * from ace_hunter.job_commands")).rejects.toMatchObject({ code: "42501" });
  });
});
