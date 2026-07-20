import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
let root: string;
let fakeBin: string;
let state: string;
let log: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ace-hunter-launch-agent-"));
  fakeBin = join(root, "bin");
  state = join(root, "disabled.state");
  log = join(root, "launchctl.log");
  await mkdir(fakeBin);
  const launchctl = join(fakeBin, "launchctl");
  await writeFile(launchctl, `#!/bin/bash
printf '%s\\n' "$*" >>"$FAKE_LAUNCHCTL_LOG"
case "$1" in
  enable) printf 'false' >"$FAKE_LAUNCHCTL_DISABLED_STATE";;
  bootstrap)
    [[ "$FAKE_LAUNCHCTL_BOOTSTRAP_FAILS" = true ]] && exit 9
    [[ -f "$FAKE_LAUNCHCTL_DISABLED_STATE" && "$(cat "$FAKE_LAUNCHCTL_DISABLED_STATE")" = true ]] && exit 5
    exit 0
    ;;
  *) exit 2;;
esac
`, { mode: 0o755 });
  await chmod(launchctl, 0o755);
});

afterEach(async () => rm(root, { recursive: true, force: true }));

it("enables a disabled service before bootstrap", async () => {
  await writeFile(state, "true");
  await expect(run("enable")).resolves.toBeDefined();
  expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
    "enable gui/501/com.kevinyoung.ace-hunter.collect-x",
    "bootstrap gui/501 /tmp/agent.plist",
  ]);
  expect(await readFile(state, "utf8")).toBe("false");
});

it("preserves the override and bootstraps directly in preserve mode", async () => {
  await expect(run("preserve")).resolves.toBeDefined();
  expect((await readFile(log, "utf8")).trim()).toBe("bootstrap gui/501 /tmp/agent.plist");
  await expect(readFile(state)).rejects.toMatchObject({ code: "ENOENT" });
});

it("propagates bootstrap failure", async () => {
  await expect(run("preserve", true)).rejects.toMatchObject({ code: 9 });
});

it("is the fail-fast activation path used by install.sh", async () => {
  const installer = await readFile("ops/launchd/install.sh", "utf8");
  expect(installer).toContain('"${release_root}/scripts/activate-launch-agent.sh" "$launchd_mode" "$domain" "$agent"');
  expect(installer).not.toMatch(/launchctl bootstrap[^\n]+\n(?:.|\n)*launchctl enable/u);
});

function run(mode: "enable" | "preserve", bootstrapFails = false) {
  return execFile("bash", [
    "scripts/activate-launch-agent.sh", mode, "gui/501", "/tmp/agent.plist",
    "gui/501/com.kevinyoung.ace-hunter.collect-x",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_LAUNCHCTL_LOG: log,
      FAKE_LAUNCHCTL_DISABLED_STATE: state,
      FAKE_LAUNCHCTL_BOOTSTRAP_FAILS: String(bootstrapFails),
    },
  });
}
