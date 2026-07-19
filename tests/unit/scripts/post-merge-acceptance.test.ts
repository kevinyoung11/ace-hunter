import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("waits for the three distinct successful launchd parent stages", async () => {
  const continuation = await readFile("scripts/continue-post-merge-release.sh", "utf8");
  expect(continuation).toContain("count(distinct job_name)::int n");
  expect(continuation).toContain("parent_run_id is null");
  expect(continuation).toContain("job_name=any($6::text[])");
  expect(continuation).toContain('r.rows[0].n===3');
});

it("accepts freshly recollected comments with valid idempotent analysis", async () => {
  const acceptance = await readFile("scripts/post-merge-acceptance.ts", "utf8");
  expect(acceptance).toContain("metrics_updated_at between $3 and $4");
  expect(acceptance).toContain("analyzed_at is not null");
  expect(acceptance).not.toContain("analyzed_at between $3 and $4");
  expect(acceptance).toContain("comments?.scheduled_for");
});
