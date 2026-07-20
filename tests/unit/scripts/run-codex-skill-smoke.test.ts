import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("accepts a successful real Codex exec despite unrelated OAuth MCP warnings", async () => {
  const binary = await fakeCodex(`printf 'MCP OAuth warning: login unavailable\\n' >&2\nprintf '{"kind":"trending_repositories"}\\n'`);

  const stdout = execFileSync("bash", ["scripts/run-codex-skill-smoke.sh", binary, "weekly", "prompt"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  expect(stdout).toBe('{"kind":"trending_repositories"}\n');
});

it("reports a failed Skill invocation without echoing unrelated warning text", async () => {
  const binary = await fakeCodex(`printf 'MCP OAuth warning: login unavailable\\n' >&2\nexit 42`);

  expect(() => execFileSync("bash", ["scripts/run-codex-skill-smoke.sh", binary, "potential", "prompt"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })).toThrow(/codex_skill_smoke_failed label=potential exit_status=42/u);
  try {
    execFileSync("bash", ["scripts/run-codex-skill-smoke.sh", binary, "potential", "prompt"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    expect(stderr).not.toContain("OAuth");
  }
});

async function fakeCodex(body: string) {
  const root = await mkdtemp(join(tmpdir(), "ace-codex-smoke-"));
  roots.push(root);
  const path = join(root, "codex");
  await writeFile(path, `#!/bin/sh\nif [ "$1" != exec ]; then exit 90; fi\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}
