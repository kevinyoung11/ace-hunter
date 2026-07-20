import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { verifyAcceptedTrendingOutput } from "../../../scripts/accepted-trending-output.js";

let root: string;
let smokeDir: string;
const captures = {
  daily: "2026-07-20T00:00:00.000Z",
  weekly: "2026-07-20T01:00:00.000Z",
  monthly: "2026-07-20T02:00:00.000Z",
} as const;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ace-hunter-accepted-trending-"));
  smokeDir = join(root, "release-rollback", "continuation-smoke");
  await mkdir(smokeDir, { recursive: true, mode: 0o700 });
  await writePayloads(smokeDir);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("binds each direct list and all section to the exact accepted database batch", async () => {
  await expect(verify()).resolves.toBeUndefined();
});

it("rejects a capturedAt that does not match the attributed database batch", async () => {
  const dailyPath = join(smokeDir, "daily.json");
  const daily = JSON.parse(await readFile(dailyPath, "utf8"));
  daily.lists[0].capturedAt = "2026-07-19T23:00:00.000Z";
  await writeSecureJson(dailyPath, daily);
  await expect(verify()).rejects.toThrow("accepted_trending_capture_mismatch:daily");
});

it("rejects missing, symlinked, and escaped smoke artifacts", async () => {
  await rm(join(smokeDir, "monthly.json"));
  await expect(verify()).rejects.toThrow("accepted_trending_artifact_invalid:monthly");
  await writeSecureJson(join(root, "outside.json"), single("monthly"));
  await symlink(join(root, "outside.json"), join(smokeDir, "monthly.json"));
  await expect(verify()).rejects.toThrow("accepted_trending_artifact_invalid:monthly");
  await expect(verify(join(root, "other"))).rejects.toThrow("accepted_trending_smoke_path_invalid");
});

function verify(actualSmokeDir = smokeDir) {
  return verifyAcceptedTrendingOutput({
    smokeDir: actualSmokeDir,
    expectedSmokeDir: smokeDir,
    batches: Object.entries(captures).map(([period, capturedAt]) => ({ period, capturedAt: new Date(capturedAt) })),
  });
}

async function writePayloads(directory: string) {
  await Promise.all([
    ...(["daily", "weekly", "monthly"] as const).map((period) =>
      writeSecureJson(join(directory, `${period}.json`), single(period))),
    writeSecureJson(join(directory, "all.json"), {
      kind: "trending_lists", period: "all", lists: (["daily", "weekly", "monthly"] as const)
        .map((period) => available(period)),
    }),
  ]);
}

function single(period: keyof typeof captures) {
  return { kind: "trending_lists", period, lists: [available(period)] };
}

function available(period: keyof typeof captures) {
  return { period, status: "available", capturedAt: captures[period] };
}

async function writeSecureJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
