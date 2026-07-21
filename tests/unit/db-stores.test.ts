/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { JobCommandStore } from "../../src/db/stores/job-command-store.js";
import { JobDefinitionStore } from "../../src/db/stores/job-definition-store.js";
import { OpsAuditStore } from "../../src/db/stores/ops-audit-store.js";

describe("control-plane stores use fixed database functions", () => {
  it("creates commands through the fixed function", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: "1", job_name: "collect_x_posts", executor: "local", capability: "x.posts.collect", parameters: {}, status: "queued", idempotency_key: "k", scheduled_for: null, job_run_id: null }] }) } as any;
    await new JobCommandStore(db).create({ jobName: "collect_x_posts", executor: "local", capability: "x.posts.collect", parameters: {}, idempotencyKey: "k" });
    expect(db.query.mock.calls[0][0]).toContain("ace_hunter.create_job_command(");
    expect(db.query.mock.calls[0][0]).not.toContain("insert into ace_hunter.job_commands");
  });

  it("lists definitions and audits through fixed functions", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
    const definitions = new JobDefinitionStore(db);
    const audit = new OpsAuditStore(db);
    await definitions.list();
    await audit.record({ actor: "ops", action: "test" });
    await audit.list(10);
    expect(db.query.mock.calls.map((x: unknown[]) => x[0])).toEqual([
      "select * from ace_hunter.list_job_definitions()",
      "select * from ace_hunter.record_ops_audit($1,$2,$3,$4,$5::jsonb)",
      "select * from ace_hunter.list_ops_audit($1)",
    ]);
  });
});
