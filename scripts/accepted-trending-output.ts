import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

const periods = ["daily", "weekly", "monthly"] as const;
type Period = typeof periods[number];

const available = z.object({
  period: z.enum(periods),
  status: z.literal("available"),
  capturedAt: z.string().datetime({ offset: true }),
}).passthrough();
const payload = z.object({
  kind: z.literal("trending_lists"),
  period: z.enum([...periods, "all"]),
  lists: z.array(available),
}).passthrough();

export interface AcceptedTrendingBatch {
  period: string;
  capturedAt: Date;
}

export interface AcceptedTrendingOutputOptions {
  smokeDir: string;
  expectedSmokeDir: string;
  batches: AcceptedTrendingBatch[];
}

export async function verifyAcceptedTrendingOutput(options: AcceptedTrendingOutputOptions): Promise<void> {
  const smokeDir = resolve(options.smokeDir);
  if (smokeDir !== resolve(options.expectedSmokeDir)) throw new Error("accepted_trending_smoke_path_invalid");
  const directory = await lstat(smokeDir).catch(() => null);
  if (directory === null || !directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("accepted_trending_smoke_path_invalid");
  }
  const expected = new Map<Period, number>();
  for (const row of options.batches) {
    if (!isPeriod(row.period) || !Number.isFinite(row.capturedAt.getTime()) || expected.has(row.period)) {
      throw new Error("accepted_trending_batches_invalid");
    }
    expected.set(row.period, row.capturedAt.getTime());
  }
  if (expected.size !== periods.length) throw new Error("accepted_trending_batches_invalid");

  const singles = new Map<Period, z.infer<typeof payload>>();
  for (const period of periods) {
    const value = await readPayload(smokeDir, period);
    if (value.period !== period || value.lists.length !== 1 || value.lists[0]?.period !== period) {
      throw new Error(`accepted_trending_payload_invalid:${period}`);
    }
    assertCapture(period, value.lists[0].capturedAt, expected);
    singles.set(period, value);
  }
  const all = await readPayload(smokeDir, "all");
  if (all.period !== "all" || JSON.stringify(all.lists.map((list) => list.period)) !== JSON.stringify(periods)) {
    throw new Error("accepted_trending_payload_invalid:all");
  }
  for (const list of all.lists) assertCapture(list.period, list.capturedAt, expected);
  for (const period of periods) {
    if (singles.get(period)?.lists[0]?.capturedAt !== all.lists.find((list) => list.period === period)?.capturedAt) {
      throw new Error(`accepted_trending_payload_mismatch:${period}`);
    }
  }
}

async function readPayload(smokeDir: string, name: Period | "all") {
  const path = join(smokeDir, `${name}.json`);
  const value = await lstat(path).catch(() => null);
  if (value === null || !value.isFile() || value.isSymbolicLink() || value.uid !== process.getuid?.() ||
      (value.mode & 0o077) !== 0) {
    throw new Error(`accepted_trending_artifact_invalid:${name}`);
  }
  try { return payload.parse(JSON.parse(await readFile(path, "utf8"))); }
  catch { throw new Error(`accepted_trending_payload_invalid:${name}`); }
}

function assertCapture(period: Period, capturedAt: string, expected: Map<Period, number>) {
  if (Date.parse(capturedAt) !== expected.get(period)) throw new Error(`accepted_trending_capture_mismatch:${period}`);
}

function isPeriod(value: string): value is Period {
  return periods.includes(value as Period);
}
