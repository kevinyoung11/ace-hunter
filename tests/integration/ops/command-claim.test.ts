import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { migrate } from "../../../src/db/migrate.js";
import { createVerifiedTestPools, parseTestDatabaseConfig } from "../../helpers/test-database.js";
import { readFileSync } from "node:fs"; import { createHash } from "node:crypto";
const config = parseTestDatabaseConfig(process.env); let admin: Pool; let migrator: Pool; let runtime: Pool;
const checksum = createHash("sha256").update(readFileSync("src/db/migrations/0001_ace_hunter_initial.sql")).digest("hex");
beforeAll(async () => { ({ adminPool: admin, migratorPool: migrator, runtimePool: runtime } = await createVerifiedTestPools({ ACE_TEST_ADMIN_DATABASE_URL: config.adminDatabaseUrl, ACE_TEST_MIGRATION_DATABASE_URL: config.migrationDatabaseUrl, ACE_TEST_RUNTIME_DATABASE_URL: config.runtimeDatabaseUrl })); await admin.query("drop schema if exists ace_hunter cascade; create schema ace_hunter authorization ace_hunter_owner"); await migrate(migrator, { expectedChecksum: checksum }); });
afterAll(async () => { await Promise.all([admin.end(), migrator.end(), runtime.end()]); });
describe("command claim", () => {
  it("claims one queued local command under concurrent workers", async () => {
    await admin.query("insert into ace_hunter.job_commands(job_name,executor,capability,idempotency_key) values ('collect_x_posts','local','x.posts.collect','claim-test')");
    const [a,b] = await Promise.all([admin.query("select id,status,claimed_by from ace_hunter.claim_job_command('worker-a','local',array['x.posts.collect'])"), admin.query("select id,status,claimed_by from ace_hunter.claim_job_command('worker-b','local',array['x.posts.collect'])")]);
    const claimed = [a.rows[0], b.rows[0]].filter(Boolean); expect(claimed).toHaveLength(1); expect(claimed[0].status).toBe("claimed");
  });
  it("enforces idempotency and queued-only cancellation", async () => {
    await expect(admin.query("insert into ace_hunter.job_commands(job_name,executor,capability,idempotency_key) values ('collect_x_posts','local','x.posts.collect','claim-test')")).rejects.toMatchObject({ code: "23505" });
    const scheduled = "2030-01-01T00:00:00Z";
    await admin.query("insert into ace_hunter.job_commands(job_name,executor,capability,idempotency_key,scheduled_for) values ('collect_x_posts','local','x.posts.collect','scheduled-a',$1)",[scheduled]);
    await expect(admin.query("insert into ace_hunter.job_commands(job_name,executor,capability,idempotency_key,scheduled_for) values ('collect_x_posts','local','x.posts.collect','scheduled-b',$1)",[scheduled])).rejects.toMatchObject({ code: "23505" });
    const queued = (await admin.query("select id from ace_hunter.job_commands where idempotency_key='scheduled-a'")).rows[0].id;
    await admin.query("select * from ace_hunter.cancel_job_command($1,'ops')", [queued]);
    await expect(admin.query("select * from ace_hunter.start_job_command($1,'worker-a')", [queued])).rejects.toMatchObject({ code: "42501" });
  });
  it("rejects reverse or invalid state transitions", async () => {
    const id = (await admin.query("insert into ace_hunter.job_commands(job_name,executor,capability,idempotency_key) values ('collect_x_posts','local','x.posts.collect','reverse-test') returning id")).rows[0].id;
    await expect(admin.query("select * from ace_hunter.bind_job_run($1,'worker-a',$2)", [id, "00000000-0000-4000-8000-000000000001"])).rejects.toMatchObject({ code: "42501" });
    await expect(admin.query("select * from ace_hunter.complete_job_command($1,'worker-a','succeeded')", [id])).rejects.toMatchObject({ code: "42501" });
  });
});
