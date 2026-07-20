import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

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

describe("immutable release signal acceptance", () => {
  it("runs every minimal signal CLI smoke directly from the immutable release", async () => {
    const continuation = await readFile("scripts/continue-post-merge-release.sh", "utf8");
    const commands = [
      "potential --format json",
      "trending daily --format json",
      "trending weekly --format json",
      "trending monthly --format json",
      "trending all --format json",
    ];

    for (const command of commands) {
      expect(continuation).toContain(
        `ACE_HUNTER_ENV_FILE="$live_env" "$node_path" "${"${release}"}/dist/src/cli/index.js" ${command} >/dev/null`,
      );
    }
  });

  it("exercises representative Trending and potential Skill routes through Codex", async () => {
    const continuation = await readFile("scripts/continue-post-merge-release.sh", "utf8");
    expect(continuation).toContain(
      "Use $ace-hunter to show the weekly GitHub Trending list. Return only the tool result.",
    );
    expect(continuation).toContain(
      "Use $ace-hunter to show potential GitHub repositories. Return only the tool result.",
    );
  });
});

describe("post-merge database facts", () => {
  it("requires latest candidate snapshots to carry only candidate-v2 provenance", async () => {
    const acceptance = await readFile("scripts/post-merge-acceptance.ts", "utf8");
    expect(acceptance).toContain("distinct on (repository_id)");
    expect(acceptance).toContain("candidate_rule_version='v2'");
    expect(acceptance).toContain("candidate_buckets <@ array['age_1d_stars_10','age_3d_stars_100']::text[]");
    expect(acceptance).toContain("missing_candidate_v2_snapshot");
    expect(acceptance).toContain("invalid_candidate_v2_snapshot");
  });

  it("requires a terminal attributable complete all-language batch for every period", async () => {
    const acceptance = await readFile("scripts/post-merge-acceptance.ts", "utf8");
    for (const semantic of [
      "trending.language='all'",
      "count(trending.job_run_id)=count(*)",
      "count(distinct trending.job_run_id)=1",
      "bool_and(trending.collection_status='success')",
      "run.status='success'",
      "run.completed_at is not null",
      "run.items_failed=0",
      "run.items_succeeded=candidate.row_count",
      "run.parameters->>'orchestrator_workflow'='trending.yml'",
      "missing_complete_trending_batch",
    ]) expect(acceptance).toContain(semantic);
    expect(acceptance).toContain('["daily", "monthly", "weekly"]');
  });

  it("keeps production history read-only during fact verification", async () => {
    const acceptance = await readFile("scripts/post-merge-acceptance.ts", "utf8");
    expect(acceptance).not.toMatch(/\b(?:delete\s+from|truncate)\b/iu);
  });
});
