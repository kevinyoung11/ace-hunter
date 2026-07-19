import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

const workflowExpectations = {
  "discover.yml": {
    cron: "17 */6 * * *",
    commands: ["discover_github_candidates"],
  },
  "trending.yml": {
    cron: "7 */4 * * *",
    commands: [
      "collect_github_trending --period daily",
      "collect_github_trending --period weekly",
      "collect_github_trending --period monthly",
    ],
  },
  "refresh-metrics.yml": {
    cron: "23 * * * *",
    commands: ["refresh_repo_metrics"],
  },
  "daily-report.yml": {
    cron: "30 0 * * *",
    commands: ["generate_report --cutoff-hour-utc 0"],
  },
  "retention.yml": {
    cron: "45 2 * * *",
    commands: ["retention"],
  },
  "evaluate-success.yml": {
    cron: "15 3 * * *",
    commands: ["evaluate_success"],
  },
} as const;

describe("hosted production schedules", () => {
  for (const [file, expected] of Object.entries(workflowExpectations)) {
    it(`${file} uses the confirmed UTC schedule, safety controls, and attribution`, async () => {
      const yaml = await readFile(`.github/workflows/${file}`, "utf8");

      expect(yaml).toContain(`cron: '${expected.cron}'`);
      expect(yaml).toContain("workflow_dispatch:");
      expect(yaml).toContain("permissions:\n  contents: read");
      expect(yaml).toMatch(/timeout-minutes:\s+\d+/u);
      expect(yaml).toContain("concurrency:");
      expect(yaml).toContain("cancel-in-progress: false");
      expect(yaml).toContain("environment: ace-hunter-production");
      expect(yaml).toContain("ACE_HUNTER_RUNTIME_DATABASE_URL: ${{ secrets.ACE_HUNTER_RUNTIME_DATABASE_URL }}");
      for (const command of expected.commands) {
        expect(yaml).toContain(`job ${command}`);
      }
      expect(yaml).toContain("--orchestrator-run-id '${{ github.run_id }}'");
      expect(yaml).toContain("--orchestrator-run-attempt '${{ github.run_attempt }}'");
      expect(yaml).toContain(`--orchestrator-workflow '${file}'`);
    });
  }

  it("keeps X manual in Actions and runs the complete X pipeline with one attribution", async () => {
    const yaml = await readFile(".github/workflows/collect-x.yml", "utf8");

    expect(yaml).toContain("workflow_dispatch:");
    expect(yaml).not.toContain("schedule:");
    expect(yaml).toContain("runs-on: [self-hosted, ace-hunter]");
    expect(yaml).toContain("permissions:\n  contents: read");
    expect(yaml).toMatch(/timeout-minutes:\s+\d+/u);
    expect(yaml).toContain("concurrency:");
    expect(yaml).toContain("environment: ace-hunter-production");
    expect(yaml).toContain("ACE_HUNTER_DEEPSEEK_API_KEY: ${{ secrets.ACE_HUNTER_DEEPSEEK_API_KEY }}");
    for (const command of ["collect_x_posts", "analyze_x_posts", "collect_x_comments"]) {
      expect(yaml).toContain(`job ${command}`);
    }
    expect(yaml.match(/--orchestrator-run-id '\$\{\{ github\.run_id \}\}'/gu)).toHaveLength(3);
    expect(yaml.match(/--orchestrator-run-attempt '\$\{\{ github\.run_attempt \}\}'/gu)).toHaveLength(3);
    expect(yaml.match(/--orchestrator-workflow 'collect-x\.yml'/gu)).toHaveLength(3);
  });
});

it("runs every quality gate against PostgreSQL 14 in CI", async () => {
  const yaml = await readFile(".github/workflows/ci.yml", "utf8");

  expect(yaml).toContain("pull_request:");
  expect(yaml).toContain("branches: [main]");
  expect(yaml).toContain("contents: read");
  expect(yaml).toContain("timeout-minutes: 20");
  expect(yaml).toContain("concurrency:");
  expect(yaml).toContain("image: postgres:14");
  expect(yaml.match(/bootstrap-test-db\.sql/gu)).toHaveLength(2);
  expect(yaml).toContain("ACE_TEST_ADMIN_DATABASE_URL:");
  expect(yaml).toContain("ACE_TEST_MIGRATION_DATABASE_URL:");
  expect(yaml).toContain("ACE_TEST_RUNTIME_DATABASE_URL:");
  for (const gate of [
    "npm test -- --run",
    "npm run typecheck",
    "npm run lint",
    "npm run build",
    "node scripts/validate-skill.mjs skills/ace-hunter",
  ]) {
    expect(yaml).toContain(gate);
  }
});

describe("portable Skill validator", () => {
  it("validates the checked-in Skill without Python dependencies", async () => {
    await expect(execFileAsync(process.execPath, [
      "scripts/validate-skill.mjs",
      "skills/ace-hunter",
    ])).resolves.toMatchObject({ stdout: "validated ace-hunter\n" });
  });

  it("rejects an invalid name and a missing agent manifest", async () => {
    const invalidName = await makeSkill("Bad_Name", true);
    const missingManifest = await makeSkill("valid-name", false);

    await expect(execFileAsync(process.execPath, ["scripts/validate-skill.mjs", invalidName]))
      .rejects.toThrow(/skill name is invalid/u);
    await expect(execFileAsync(process.execPath, ["scripts/validate-skill.mjs", missingManifest]))
      .rejects.toThrow();
  });
});

async function makeSkill(name: string, withManifest: boolean): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ace-hunter-skill-"));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill\n---\n`);
  if (withManifest) {
    await mkdir(join(directory, "agents"));
    await writeFile(join(directory, "agents/openai.yaml"), "interface: {}\n");
  }
  return directory;
}
