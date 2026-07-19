import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const launcherPath = "ops/self-hosted-runner/launch-ephemeral.sh";

describe("ephemeral self-hosted runner", () => {
  it("pins the verified official macOS arm64 runner asset", async () => {
    const lock = await readFile("ops/self-hosted-runner/actions-runner.lock", "utf8");
    expect(lock).toBe([
      "version=2.335.1",
      "osx_arm64_sha256=e1a9bc7a3661e06fa0b129d15c2064fe65dc81a431001d8958a9db1409b73769",
      "",
    ].join("\n"));
  });

  it("validates, downloads, verifies, and parses the pinned archive without shell evaluation", async () => {
    const launcher = await readFile(launcherPath, "utf8");
    await expect(execFileAsync("/bin/bash", ["-n", launcherPath])).resolves.toBeDefined();
    expect(launcher).toContain("https://github.com/actions/runner/releases/download/v${runner_version}/actions-runner-osx-arm64-${runner_version}.tar.gz");
    expect(launcher).toContain("shasum -a 256 -c -");
    expect(launcher).toContain("dist/scripts/assert-twitter-preflight.js");
    expect(launcher).not.toMatch(/\beval\b|\bsource\b/);
  });

  it("runs from an archive release root without requiring Git metadata", async () => {
    const launcher = await readFile(launcherPath, "utf8");
    expect(launcher).toContain('script_dir=$(cd "$(dirname "$0")" && pwd -P)');
    expect(launcher).toContain('repo_root=$(cd "$script_dir/../.." && pwd -P)');
    expect(launcher).toContain('release-manifest.json');
    expect(launcher).toContain('test "$manifest_sha" = "$main_sha"');
    expect(launcher).not.toContain("git rev-parse");
    expect(launcher).not.toMatch(/required_command in[^\n]*\bgit\b/);
  });

  it("only dispatches after online and identifies the run by time, SHA, and database ID", async () => {
    const launcher = await readFile(launcherPath, "utf8");
    const online = launcher.indexOf('test "$runner_status" = "online"');
    const dispatch = launcher.indexOf("gh workflow run");
    expect(online).toBeGreaterThan(0);
    expect(dispatch).toBeGreaterThan(online);
    expect(launcher).toContain("max_before");
    expect(launcher).toContain("dispatch_at");
    expect(launcher).toContain(".headSha");
    expect(launcher).toContain(".createdAt");
    expect(launcher).toContain(".databaseId");
  });

  it("watches the exact run, waits for the process, proves deregistration, and trap-cleans", async () => {
    const launcher = await readFile(launcherPath, "utf8");
    expect(launcher).toContain('gh run watch "$run_id"');
    expect(launcher).toContain('wait "$runner_pid"');
    expect(launcher).toContain('repos/$GH_REPO/actions/runners/$runner_id');
    expect(launcher).toContain("trap cleanup EXIT");
    expect(launcher).toContain("trap 'exit 130' INT");
    expect(launcher).toContain("trap 'exit 143' TERM");
  });

  it("emits only the attributable workflow run JSON on successful stdout", async () => {
    const launcher = await readFile(launcherPath, "utf8");
    expect(launcher).toContain(".run_attempt");
    expect(launcher).toContain("{\"workflow\":\"collect-x.yml\",\"databaseId\":%s,\"runAttempt\":%s}");
    expect(launcher).not.toContain("ephemeral collect-x workflow completed");
  });
});

describe("operations runbook", () => {
  it("documents every production boundary without secret values", async () => {
    const runbook = await readFile("docs/operations/ace-hunter-runbook.md", "utf8");
    for (const required of [
      "PostgreSQL 14",
      "ace_hunter_migrator",
      "ace_hunter_runtime",
      "pending",
      "analyzed",
      "success_empty",
      "failed",
      "partial",
      "forward-only",
      "Keychain",
      "Twitter",
      "sleep",
      "rollback",
      "uninstall",
      "ACE_HUNTER_RUNTIME_DATABASE_URL",
      "ACE_HUNTER_GITHUB_TOKEN",
      "ACE_HUNTER_USER_ID",
      "ACE_HUNTER_DEEPSEEK_API_KEY",
    ]) expect(runbook).toContain(required);
    expect(runbook).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}|postgres(?:ql)?:\/\/[^\s`]+:[^\s`]+@/i);
  });
});
