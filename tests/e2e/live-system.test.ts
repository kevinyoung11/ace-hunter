import { Pool } from "pg";
import { expect, it } from "vitest";
import { rankCandidates, type ScoreInput, type XRunStatus } from "../../src/analysis/scoring.js";
import { loadRuntimeConfig } from "../../src/config/load-config.js";

interface StoredOutput {
  output_type: "daily_report" | "realtime_observation";
  status: "complete" | "partial";
  structured_content: {
    report?: { items?: Array<{ productId: string; score: Record<string, number | null> }> };
    sourceCandidates?: Array<Omit<ScoreInput, "snapshotObservedAt"> & { snapshotObservedAt?: string }>;
    sourceXRunStatus?: XRunStatus;
  };
  rendered_markdown: string;
}

it.runIf(process.env.RUN_LIVE_E2E === "1")(
  "stores a fresh real Top 10 report and realtime observation with replayable scores",
  async () => {
    const startedAt = requiredDate("ACE_E2E_STARTED_AT");
    const pool = new Pool({
      connectionString: loadRuntimeConfig(process.env).runtimeDatabaseUrl,
      max: 1,
    });
    try {
      const result = await pool.query<StoredOutput>(`select distinct on (output_type)
          output_type,status,structured_content,rendered_markdown
        from ace_hunter.analysis_outputs
        where (output_type='daily_report' and completed_at >= $1)
           or (output_type='realtime_observation' and created_at >= $1)
        order by output_type,coalesce(completed_at,created_at) desc,id desc`, [startedAt]);

      expect(new Set(result.rows.map((row) => row.output_type))).toEqual(
        new Set(["daily_report", "realtime_observation"]),
      );
      expect(result.rows.every((row) =>
        ["complete", "partial"].includes(row.status) && row.rendered_markdown.trim().length > 0,
      )).toBe(true);

      const daily = result.rows.find((row) => row.output_type === "daily_report");
      expect(daily).toBeDefined();
      const items = daily?.structured_content.report?.items;
      expect(items?.length).toBeGreaterThan(0);
      expect(items?.length).toBeLessThanOrEqual(10);

      const sourceCandidates = daily?.structured_content.sourceCandidates;
      const xRunStatus = daily?.structured_content.sourceXRunStatus;
      expect(sourceCandidates?.length).toBeGreaterThan(0);
      expect(xRunStatus).toMatch(/^(success|partial|unavailable)$/);
      const recomputed = rankCandidates(
        (sourceCandidates ?? []).map((candidate) => ({
          ...candidate,
          snapshotObservedAt: candidate.snapshotObservedAt === undefined
            ? undefined
            : new Date(candidate.snapshotObservedAt),
        })),
        xRunStatus ?? "unavailable",
      );
      const stored = items?.[0];
      const replayed = recomputed.find((candidate) => candidate.productId === stored?.productId);
      expect(replayed).toBeDefined();
      for (const field of ["githubMomentum", "xAttention", "trendingSignal", "attentionScore"] as const) {
        const expectedValue = stored?.score[field];
        const actualValue = replayed?.[field];
        if (expectedValue === null) expect(actualValue).toBeNull();
        else expect(Math.abs((actualValue ?? Number.NaN) - (expectedValue ?? Number.NaN))).toBeLessThanOrEqual(0.000001);
      }

      const classified = await pool.query<{ x_post_id: string; post_url: string; model_name: string }>(`select
          x_post_id,post_url,model_name
        from ace_hunter.product_x_posts
        where model_name=$1 and analysis_version is not null
        order by analyzed_at desc,x_post_id limit 1`, [loadRuntimeConfig(process.env).deepseekModel]);
      expect(classified.rowCount).toBe(1);
      expect(classified.rows[0].x_post_id).toMatch(/^\d+$/);
      expect(classified.rows[0].post_url).toMatch(/^https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d+$/);
      const freshAnalysisJob = await pool.query(`select 1 from ace_hunter.job_runs
        where job_name='analyze_x_posts' and started_at >= $1 and status in ('success','partial') limit 1`, [startedAt]);
      expect(freshAnalysisJob.rowCount).toBe(1);
    } finally {
      await pool.end();
    }
  },
  30_000,
);

function requiredDate(name: string): Date {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name}_required`);
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name}_invalid`);
  return parsed;
}
