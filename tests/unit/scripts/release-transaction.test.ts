import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
let root: string;
let home: string;
let app: string;
let codex: string;
let tx: string;
let fakeBin: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ace-hunter-release-tx-"));
  home = join(root, "home");
  app = join(home, "Library", "Application Support", "AceHunter");
  codex = join(root, "codex");
  tx = join(root, "owner-only", "release-rollback");
  fakeBin = join(root, "bin");
  await Promise.all([
    mkdir(join(app, "bin"), { recursive: true }), mkdir(join(codex, "skills"), { recursive: true }),
    mkdir(join(home, "Library", "LaunchAgents"), { recursive: true }), mkdir(join(root, "owner-only"), { mode: 0o700 }),
    mkdir(fakeBin),
  ]);
  const launchctl = join(fakeBin, "launchctl");
  await writeFile(launchctl, "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  await chmod(launchctl, 0o755);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("restores prior release artifacts and rebinds the prior LaunchAgent after later failure", async () => {
  const prior = join(app, "releases", "prior");
  const next = join(app, "releases", "next");
  await Promise.all([mkdir(join(prior, "skills", "ace-hunter"), { recursive: true }), mkdir(next, { recursive: true })]);
  await symlink(prior, join(app, "current"));
  await writeFile(join(app, "bin", "ace-hunter"), "prior-wrapper\n", { mode: 0o755 });
  await symlink(join(prior, "skills", "ace-hunter"), join(codex, "skills", "ace-hunter"));
  await writeFile(join(app, "bin", "keychain-secret"), "prior-helper\n", { mode: 0o700 });
  await writeFile(join(app, "scheduler.conf"), `RELEASE_ROOT=${prior}\n`, { mode: 0o600 });
  const agent = join(home, "Library", "LaunchAgents", "com.kevinyoung.ace-hunter.collect-x.plist");
  await writeFile(agent, `prior=${prior}\n`, { mode: 0o600 });

  await run("begin");
  await Promise.all([rm(join(app, "current")), rm(join(codex, "skills", "ace-hunter"))]);
  await symlink(next, join(app, "current"));
  await symlink(join(next, "skills"), join(codex, "skills", "ace-hunter"));
  await writeFile(join(app, "bin", "ace-hunter"), "next-wrapper\n");
  await writeFile(join(app, "scheduler.conf"), `RELEASE_ROOT=${next}\n`);
  await writeFile(agent, `next=${next}\n`);

  await run("rollback");

  expect(await readlink(join(app, "current"))).toBe(prior);
  expect(await readFile(join(app, "bin", "ace-hunter"), "utf8")).toBe("prior-wrapper\n");
  expect(await readlink(join(codex, "skills", "ace-hunter"))).toBe(join(prior, "skills", "ace-hunter"));
  expect(await readFile(join(app, "scheduler.conf"), "utf8")).toBe(`RELEASE_ROOT=${prior}\n`);
  expect(await readFile(agent, "utf8")).toBe(`prior=${prior}\n`);
});

it("safely removes newly installed LaunchAgent artifacts when no prior install existed", async () => {
  await run("begin");
  const agent = join(home, "Library", "LaunchAgents", "com.kevinyoung.ace-hunter.collect-x.plist");
  await writeFile(join(app, "bin", "keychain-secret"), "new-helper\n");
  await writeFile(join(app, "scheduler.conf"), "RELEASE_ROOT=next\n");
  await writeFile(agent, "next\n");

  await run("rollback");

  await expect(readFile(join(app, "bin", "keychain-secret"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(app, "scheduler.conf"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(agent)).rejects.toMatchObject({ code: "ENOENT" });
});

function run(action: "begin" | "rollback" | "commit") {
  const args = action === "begin"
    ? ["scripts/release-transaction.mjs", action, tx, app, codex]
    : ["scripts/release-transaction.mjs", action, tx];
  return execFile("node", args, {
    cwd: process.cwd(), env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}` },
  });
}
