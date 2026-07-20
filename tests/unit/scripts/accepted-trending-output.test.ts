import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterEach, beforeEach, expect, it } from "vitest";
import { verifyAcceptedSignalOutput } from "../../../scripts/accepted-trending-output.js";

const generatedAt = "2026-07-20T12:00:00.000Z";
const captures = {
  daily: "2026-07-20T00:00:00.000Z",
  weekly: "2026-07-20T01:00:00.000Z",
  monthly: "2026-07-20T02:00:00.000Z",
} as const;
type Period = keyof typeof captures;
interface MutableTrendingPayload {
  lists: Array<{
    sourceUrl: string;
    capturedAt: string;
    items: Array<{ rank: number; repositoryId: string; stars: number }>;
  }>;
}
let root: string;
let smokeDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ace-hunter-accepted-signal-"));
  smokeDir = join(root, "release-rollback", "continuation-smoke");
  await mkdir(smokeDir, { recursive: true, mode: 0o700 });
  await writePayloads(smokeDir);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("binds Trending Top20 and potential Top20 to independent database facts", async () => {
  await expect(verify()).resolves.toBeUndefined();
});

it("rejects empty accepted Trending items and fake rank/repository/source/Star facts", async () => {
  const mutations: Array<[string, (value: MutableTrendingPayload) => void]> = [
    ["empty", (value) => { value.lists[0].items = []; }],
    ["rank", (value) => { value.lists[0].items[0].rank = 2; }],
    ["repository", (value) => { value.lists[0].items[0].repositoryId = "fake-repo"; }],
    ["source", (value) => { value.lists[0].sourceUrl = "https://example.com/fake"; }],
    ["star", (value) => { value.lists[0].items[0].stars = 999; }],
  ];
  for (const [name, mutate] of mutations) {
    await writePayloads(smokeDir);
    const path = join(smokeDir, "daily.json");
    const value = JSON.parse(await readFile(path, "utf8")) as MutableTrendingPayload;
    mutate(value);
    await writeSecureJson(path, value);
    await expect(verify(), name).rejects.toThrow(/accepted_trending_(?:items_empty|facts_mismatch):daily/u);
  }
});

it("rejects a fake potential item even when direct and Skill could agree", async () => {
  const path = join(smokeDir, "potential.json");
  const value = JSON.parse(await readFile(path, "utf8")) as ReturnType<typeof potentialPayload>;
  value.items[0].stars = 999;
  await writeSecureJson(path, value);
  await expect(verify()).rejects.toThrow("accepted_potential_facts_mismatch");
});

it("rejects a capturedAt that does not match the attributed database batch", async () => {
  const dailyPath = join(smokeDir, "daily.json");
  const daily = JSON.parse(await readFile(dailyPath, "utf8")) as MutableTrendingPayload;
  daily.lists[0].capturedAt = "2026-07-19T23:00:00.000Z";
  await writeSecureJson(dailyPath, daily);
  await expect(verify()).rejects.toThrow("accepted_trending_capture_mismatch:daily");
});

it("requires each single-period list to equal the corresponding all-period list", async () => {
  const allPath = join(smokeDir, "all.json");
  const all = JSON.parse(await readFile(allPath, "utf8")) as ReturnType<typeof allPayload>;
  all.generatedAt = "2026-07-20T12:05:00.000Z";
  for (const list of all.lists) {
    list.items[0].stars = 101;
    list.items[0].starsCapturedAt = "2026-07-20T12:01:00.000Z";
  }
  await writeSecureJson(allPath, all);
  const changingPool = fakePool((period, cutoff) => ({
    ...trendingDatabaseRow(period),
    stars: cutoff === all.generatedAt ? 101 : 100,
    stars_captured_at: new Date(cutoff === all.generatedAt
      ? "2026-07-20T12:01:00.000Z"
      : "2026-07-20T11:00:00.000Z"),
  }));

  await expect(verify(smokeDir, changingPool)).rejects.toThrow("accepted_trending_payload_mismatch:daily");
});

it("derives freshness from capturedAt and generatedAt instead of trusting stale=false", async () => {
  for (const name of ["daily", "weekly", "monthly", "all"] as const) {
    const path = join(smokeDir, `${name}.json`);
    const value = JSON.parse(await readFile(path, "utf8")) as { generatedAt: string };
    value.generatedAt = "2026-07-22T12:00:00.000Z";
    await writeSecureJson(path, value);
  }
  await expect(verify()).rejects.toThrow("accepted_trending_stale:daily");
});

it("rejects missing, symlinked, and escaped smoke artifacts", async () => {
  await rm(join(smokeDir, "monthly.json"));
  await expect(verify()).rejects.toThrow("accepted_signal_artifact_invalid:monthly");
  await writeSecureJson(join(root, "outside.json"), single("monthly"));
  await symlink(join(root, "outside.json"), join(smokeDir, "monthly.json"));
  await expect(verify()).rejects.toThrow("accepted_signal_artifact_invalid:monthly");
  await expect(verify(join(root, "other"))).rejects.toThrow("accepted_signal_smoke_path_invalid");
  await chmod(smokeDir, 0o755);
  await expect(verify()).rejects.toThrow("accepted_signal_smoke_path_invalid");
});

function verify(actualSmokeDir = smokeDir, pool = fakePool()) {
  return verifyAcceptedSignalOutput({
    pool: pool as unknown as Pick<Pool, "query">, smokeDir: actualSmokeDir, expectedSmokeDir: smokeDir,
    batches: (Object.entries(captures) as Array<[Period, string]>).map(([period, capturedAt]) => ({
      period, capturedAt: new Date(capturedAt), jobRunId: jobRunIds[period],
    })),
  });
}

const jobRunIds: Record<Period, string> = {
  daily: "00000000-0000-4000-8000-000000000001",
  weekly: "00000000-0000-4000-8000-000000000002",
  monthly: "00000000-0000-4000-8000-000000000003",
};

function fakePool(
  trendingRow: (period: Period, cutoff: string) => ReturnType<typeof trendingDatabaseRow> = trendingDatabaseRow,
) {
  return {
    query: async (text: string, values: unknown[]) => {
      if (text.includes("accepted_trending_facts")) {
        const period = values[0] as Period;
        return { rows: [trendingRow(period, (values[3] as Date).toISOString())] };
      }
      if (text.includes("accepted_potential_facts")) return { rows: [potentialDatabaseRow()] };
      throw new Error("unexpected_acceptance_query");
    },
  };
}

async function writePayloads(directory: string) {
  await Promise.all([
    ...(["daily", "weekly", "monthly"] as const).map((period) =>
      writeSecureJson(join(directory, `${period}.json`), single(period))),
    writeSecureJson(join(directory, "all.json"), allPayload()),
    writeSecureJson(join(directory, "potential.json"), potentialPayload()),
  ]);
}

function allPayload() {
  return {
    kind: "trending_lists" as const, period: "all" as const, generatedAt,
    lists: (["daily", "weekly", "monthly"] as const).map((period) => available(period)),
  };
}

function single(period: Period) {
  return { kind: "trending_lists", period, generatedAt, lists: [available(period)] };
}

function available(period: Period) {
  return {
    period, status: "available", capturedAt: captures[period],
    sourceUrl: `https://github.com/trending?since=${period}`, stale: false,
    items: [trendingItem()],
  };
}

function trendingItem() {
  return {
    repositoryId: "repo-1", rank: 1, name: "repo", fullName: "owner/repo", description: "demo",
    owner: "owner", repositoryUrl: "https://github.com/owner/repo", homepageUrl: "https://repo.example/",
    stars: 100, starsCapturedAt: "2026-07-20T11:00:00.000Z", starsInPeriod: 20,
  };
}

function potentialPayload() {
  return {
    kind: "potential_repositories", rule: "all", generatedAt, items: [{
      repositoryId: "repo-1", name: "repo", fullName: "owner/repo", description: "demo", owner: "owner",
      repositoryUrl: "https://github.com/owner/repo", homepageUrl: "https://repo.example/",
      createdAt: "2026-07-20T00:00:00.000Z", ageHours: 12, stars: 100,
      starsPerHour: 100 / 12, forks: 5, capturedAt: "2026-07-20T11:00:00.000Z",
      matchedRules: ["1d", "3d"],
    }],
  };
}

function trendingDatabaseRow(period: Period) {
  return {
    rank: 1, stars_in_period: 20, source_url: `https://github.com/trending?since=${period}`,
    repository_id: "repo-1", name: "repo", full_name: "owner/repo", description: "demo", owner_login: "owner",
    repo_url: "https://github.com/owner/repo", homepage_url: "https://repo.example/", stars: 100,
    stars_captured_at: new Date("2026-07-20T11:00:00.000Z"),
  };
}

function potentialDatabaseRow() {
  return {
    repository_id: "repo-1", name: "repo", full_name: "owner/repo", description: "demo", owner_login: "owner",
    repo_url: "https://github.com/owner/repo", homepage_url: "https://repo.example/",
    github_created_at: new Date("2026-07-20T00:00:00.000Z"),
    effective_observed_at: new Date("2026-07-20T11:00:00.000Z"), stars: 100, forks: 5,
  };
}

async function writeSecureJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
