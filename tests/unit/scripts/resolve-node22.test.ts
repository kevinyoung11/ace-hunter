import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fakeNode(version: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ace-hunter-node-runtime-"));
  temporaryDirectories.push(directory);
  const binary = join(directory, "node");
  await writeFile(binary, `#!/bin/bash\nprintf '%s\\n' '${version}'\n`);
  await chmod(binary, 0o755);
  return binary;
}

it("selects Node 22 even when an earlier candidate is Node 25", async () => {
  const node25 = await fakeNode("v25.6.1");
  const node22 = await fakeNode("v22.17.0");

  const result = await execFile("bash", ["scripts/resolve-node22.sh"], {
    env: {
      ...process.env,
      PATH: `${join(node25, "..")}:${join(node22, "..")}:/usr/bin:/bin`,
    },
  });

  expect(result.stdout.trim()).toBe(await realpath(node22));
  expect(result.stderr).toBe("");
});

it("fails explicitly when no candidate is Node 22", async () => {
  const node25 = await fakeNode("v25.6.1");

  await expect(execFile("bash", ["scripts/resolve-node22.sh", node25])).rejects.toMatchObject({
    code: 1,
    stderr: "node22_runtime_not_found\n",
  });
});

it("routes every local release and LaunchAgent entrypoint through the Node 22 resolver", async () => {
  const files = await Promise.all([
    "scripts/run-post-merge-release.sh",
    "ops/launchd/deploy-main.sh",
    "scripts/continue-post-merge-release.sh",
    "ops/launchd/install.sh",
    "scripts/run-user-command.sh",
    "scripts/run-scheduled-x.sh",
  ].map(async (path) => [path, await readFile(path, "utf8")] as const));

  for (const [path, script] of files) {
    expect(script, path).toContain("resolve-node22.sh");
  }
  expect(files.map(([, script]) => script).join("\n")).not.toContain("command -v node");
});
