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
  await expect(run(files)).resolves.toMatchObject({ stdout: "signal_release_validation_passed\n" });
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

it("rejects a default potential smoke that does not report the all rule", async () => {
  const files = await writeFixtureSet();
  for (const path of [files.potential, files.skillPotential]) {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    value.rule = "1d";
    await writeJson(path, value);
  }
  await expect(run(files)).rejects.toMatchObject({ stderr: expect.stringContaining("invalid_potential_payload") });
});

async function writeFixtureSet() {
  await mkdir(root, { recursive: true });
  const paths = Object.fromEntries(["potential", "daily", "weekly", "monthly", "all", "skillWeekly", "skillPotential"]
    .map((name) => [name, join(root, `${name}.json`)])) as Record<string, string>;
  const generatedAt = "2026-07-20T01:00:00.000Z";
  const unavailable = (period: string) => ({ period, status: "unavailable" });
  const potential = { kind: "potential_repositories", rule: "all", generatedAt, items: [] };
  const daily = { kind: "not_found", reason: "trending_unavailable", period: "daily", generatedAt,
    lists: [unavailable("daily")] };
  const weekly = { kind: "trending_lists", period: "weekly", generatedAt, lists: [{
    period: "weekly", status: "available", capturedAt: "2026-07-20T00:00:00.000Z",
    sourceUrl: "https://github.com/trending?since=weekly", stale: false, items: [{
      repositoryId: "repo-1", rank: 1, name: "repo", fullName: "owner/repo", description: null,
      owner: "owner", repositoryUrl: "https://github.com/owner/repo", homepageUrl: null,
      stars: 100, starsCapturedAt: "2026-07-20T00:10:00.000Z", starsInPeriod: 20,
    }],
  }] };
  const monthly = { kind: "not_found", reason: "trending_unavailable", period: "monthly", generatedAt,
    lists: [unavailable("monthly")] };
  const all = { kind: "trending_lists", period: "all", generatedAt, lists: [
    unavailable("daily"), weekly.lists[0], unavailable("monthly"),
  ] };
  await Promise.all([
    writeJson(paths.potential, potential), writeJson(paths.daily, daily), writeJson(paths.weekly, weekly),
    writeJson(paths.monthly, monthly), writeJson(paths.all, all), writeJson(paths.skillWeekly, weekly),
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

function run(files: Awaited<ReturnType<typeof writeFixtureSet>>) {
  return execFile("node", ["--import", "tsx", "scripts/validate-signal-release.ts",
    files.potential, files.daily, files.weekly, files.monthly, files.all,
    files.skillWeekly, files.skillPotential], { cwd: process.cwd() });
}
