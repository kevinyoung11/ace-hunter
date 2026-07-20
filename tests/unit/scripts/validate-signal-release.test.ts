import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
let root: string;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ace-hunter-signal-oracle-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("accepts verified empty/not-found semantics and matching Skill facts", async () => {
  const files = await writeFixtureSet();
  await expect(run(files, "allow-empty")).resolves.toMatchObject({ stdout: "signal_release_validation_passed\n" });
});

it("rejects all-not-found Trending after fresh workflows", async () => {
  const files = await writeFixtureSet({ weeklyAvailable: false });
  await expect(run(files, "require-fresh")).rejects.toMatchObject({
    stderr: expect.stringContaining("fresh_trending_unavailable"),
  });
});

it("rejects exit-zero Trending JSON without required source and capture facts", async () => {
  const files = await writeFixtureSet();
  await writeJson(files.daily, {
    kind: "trending_lists", period: "daily", generatedAt: "2026-07-20T01:00:00.000Z",
    lists: [{ period: "daily", status: "available", stale: false, items: [] }],
  });
  await expect(run(files)).rejects.toMatchObject({ stderr: expect.stringContaining("invalid_trending_payload") });
});

it("rejects a Skill result whose deterministic potential facts differ from direct CLI", async () => {
  const files = await writeFixtureSet();
  const value = JSON.parse(await readFile(files.skillPotential, "utf8")) as Record<string, unknown>;
  value.items = [{
    repositoryId: "repo-2", repositoryUrl: "https://github.com/owner/other", homepageUrl: null,
    createdAt: "2026-07-20T00:00:00.000Z", capturedAt: "2026-07-20T00:30:00.000Z",
    stars: 10, matchedRules: ["1d"],
  }];
  await writeJson(files.skillPotential, value);
  await expect(run(files)).rejects.toMatchObject({ stderr: expect.stringContaining("skill_potential_mismatch") });
});

it.each([
  ["missing", (item: Record<string, unknown>) => { delete item.stars; }],
  ["changed", (item: Record<string, unknown>) => { item.stars = 101; }],
  ["period stars changed", (item: Record<string, unknown>) => { item.starsInPeriod = 21; }],
])("rejects %s Star facts in the Skill Trending result", async (_name, mutate) => {
  const files = await writeFixtureSet();
  const skill = JSON.parse(await readFile(files.skillWeekly, "utf8")) as {
    lists: Array<{ items: Array<Record<string, unknown>> }>;
  };
  mutate(skill.lists[0].items[0]);
  await writeJson(files.skillWeekly, skill);
  await expect(run(files, "allow-empty")).rejects.toMatchObject({
    stderr: expect.stringMatching(/invalid_trending_payload|skill_trending_mismatch/u),
  });
});

it("rejects changed repository identity in the Skill Trending result", async () => {
  const files = await writeFixtureSet();
  const skill = JSON.parse(await readFile(files.skillWeekly, "utf8")) as {
    lists: Array<{ items: Array<Record<string, unknown>> }>;
  };
  skill.lists[0].items[0].fullName = "other/repo";
  await writeJson(files.skillWeekly, skill);
  await expect(run(files, "allow-empty")).rejects.toMatchObject({
    stderr: expect.stringContaining("skill_trending_mismatch"),
  });
});

it("accepts nullable total and period Star facts", async () => {
  const files = await writeFixtureSet();
  for (const path of [files.weekly, files.all, files.skillWeekly]) {
    const value = JSON.parse(await readFile(path, "utf8")) as {
      lists: Array<{ items?: Array<Record<string, unknown>> }>;
    };
    const weekly = value.lists.find((list) => list.items !== undefined);
    if (weekly?.items?.[0]) {
      weekly.items[0].stars = null;
      weekly.items[0].starsInPeriod = null;
    }
    await writeJson(path, value);
  }
  await expect(run(files, "allow-empty")).resolves.toMatchObject({ stdout: "signal_release_validation_passed\n" });
});

it("accepts all three visible lists in fresh mode", async () => {
  const files = await writeFixtureSet({ allPeriodsAvailable: true });
  await expect(run(files, "require-fresh")).resolves.toMatchObject({ stdout: "signal_release_validation_passed\n" });
});

it("rejects stale available lists in fresh mode", async () => {
  const files = await writeFixtureSet({ allPeriodsAvailable: true });
  for (const path of [files.daily, files.weekly, files.monthly, files.all, files.skillWeekly]) {
    const value = JSON.parse(await readFile(path, "utf8")) as {
      lists: Array<Record<string, unknown>>;
    };
    for (const list of value.lists) list.stale = true;
    await writeJson(path, value);
  }
  await expect(run(files, "require-fresh")).rejects.toMatchObject({
    stderr: expect.stringContaining("fresh_trending_stale"),
  });
});

it("rejects a default potential smoke that does not report the all rule", async () => {
  const files = await writeFixtureSet();
  for (const path of [files.potential, files.skillPotential]) {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    value.rule = "1d";
    await writeJson(path, value);
  }
  await expect(run(files)).rejects.toMatchObject({ stderr: expect.stringContaining("invalid_potential_payload") });
});

async function writeFixtureSet(options: { weeklyAvailable?: boolean; allPeriodsAvailable?: boolean } = {}) {
  await mkdir(root, { recursive: true });
  const paths = Object.fromEntries(["potential", "daily", "weekly", "monthly", "all", "skillWeekly", "skillPotential"]
    .map((name) => [name, join(root, `${name}.json`)])) as Record<string, string>;
  const generatedAt = "2026-07-20T01:00:00.000Z";
  const unavailable = (period: string) => ({ period, status: "unavailable" });
  const potential = { kind: "potential_repositories", rule: "all", generatedAt, items: [] };
  const daily = { kind: "not_found", reason: "trending_unavailable", period: "daily", generatedAt,
    lists: [unavailable("daily")] };
  const availableWeekly = {
    period: "weekly", status: "available", capturedAt: "2026-07-20T00:00:00.000Z",
    sourceUrl: "https://github.com/trending?since=weekly", stale: false, items: [{
      repositoryId: "repo-1", rank: 1, name: "repo", fullName: "owner/repo", description: null,
      owner: "owner", repositoryUrl: "https://github.com/owner/repo", homepageUrl: null,
      stars: 100, starsCapturedAt: "2026-07-20T00:10:00.000Z", starsInPeriod: 20,
    }],
  };
  const weekly = options.weeklyAvailable === false
    ? { kind: "not_found", reason: "trending_unavailable", period: "weekly", generatedAt,
        lists: [unavailable("weekly")] }
    : { kind: "trending_lists", period: "weekly", generatedAt, lists: [availableWeekly] };
  const monthly = { kind: "not_found", reason: "trending_unavailable", period: "monthly", generatedAt,
    lists: [unavailable("monthly")] };
  const availableFor = (period: "daily" | "monthly") => ({ ...availableWeekly, period,
    sourceUrl: `https://github.com/trending?since=${period}` });
  const effectiveDaily = options.allPeriodsAvailable
    ? { kind: "trending_lists", period: "daily", generatedAt, lists: [availableFor("daily")] }
    : daily;
  const effectiveMonthly = options.allPeriodsAvailable
    ? { kind: "trending_lists", period: "monthly", generatedAt, lists: [availableFor("monthly")] }
    : monthly;
  const effectiveWeekly = weekly;
  const allKind = [effectiveDaily, effectiveWeekly, effectiveMonthly]
    .every((value) => value.kind === "not_found") ? "not_found" : "trending_lists";
  const all = { kind: allKind, ...(allKind === "not_found" ? { reason: "trending_unavailable" } : {}),
    period: "all", generatedAt, lists: [
      effectiveDaily.lists[0], effectiveWeekly.lists[0], effectiveMonthly.lists[0],
    ] };
  await Promise.all([
    writeJson(paths.potential, potential), writeJson(paths.daily, effectiveDaily), writeJson(paths.weekly, effectiveWeekly),
    writeJson(paths.monthly, effectiveMonthly), writeJson(paths.all, all), writeJson(paths.skillWeekly, effectiveWeekly),
    writeJson(paths.skillPotential, potential),
  ]);
  return paths as {
    potential: string; daily: string; weekly: string; monthly: string; all: string;
    skillWeekly: string; skillPotential: string;
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function run(files: Awaited<ReturnType<typeof writeFixtureSet>>, mode: "allow-empty" | "require-fresh" = "allow-empty") {
  return execFile("node", ["--import", "tsx", "scripts/validate-signal-release.ts",
    mode, files.potential, files.daily, files.weekly, files.monthly, files.all,
    files.skillWeekly, files.skillPotential], { cwd: process.cwd() });
}
