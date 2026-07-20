import type { Pool } from "pg";
import { expect, it } from "vitest";
import { verifyAcceptedCandidateSnapshots } from "../../../scripts/accepted-candidate-provenance.js";

const discoverId = "00000000-0000-4000-8000-000000000001";
const refreshId = "00000000-0000-4000-8000-000000000002";
const concurrentId = "00000000-0000-4000-8000-000000000099";
const startedAt = new Date("2026-07-20T00:00:00.000Z");

it("accepts candidate snapshots only from the exact watched discover/refresh job IDs", async () => {
  const seen: unknown[][] = [];
  const pool = {
    query: async (_text: string, values: unknown[]) => {
      seen.push(values);
      return { rows: [{ n: JSON.stringify(values[1]) === JSON.stringify(acceptedIds) ? 1 : 0, valid: 1 }] };
    },
  } as unknown as Pick<Pool, "query">;
  const acceptedIds = [discoverId, refreshId];

  await expect(verifyAcceptedCandidateSnapshots(pool, startedAt, acceptedIds)).resolves.toBeUndefined();
  expect(seen).toEqual([[startedAt, acceptedIds]]);
});

it("does not let a concurrent unrelated job run satisfy candidate provenance", async () => {
  const pool = {
    query: async (text: string, values: unknown[]) => {
      expect(text).toContain("collected_fields->>'source_job_run_id'=any($2::text[])");
      const accepted = values[1] as string[];
      const rows = [{ sourceJobRunId: concurrentId }].filter((row) => accepted.includes(row.sourceJobRunId));
      return { rows: [{ n: rows.length, valid: rows.length }] };
    },
  } as unknown as Pick<Pool, "query">;

  await expect(verifyAcceptedCandidateSnapshots(pool, startedAt, [discoverId, refreshId]))
    .rejects.toThrow("missing_candidate_v2_snapshot");
});
