import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const currentUid = process.getuid?.() ?? -1;
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
  await writeFile(launchctl, `#!/bin/bash
printf '%s\\n' "$*" >>"$FAKE_LAUNCHCTL_LOG"
case "$1" in
  print)
    [[ -f "$FAKE_LAUNCHCTL_LOADED_STATE" ]] || printf '%s' "$FAKE_LAUNCHCTL_LOADED" >"$FAKE_LAUNCHCTL_LOADED_STATE"
    [[ "$(cat "$FAKE_LAUNCHCTL_LOADED_STATE")" = true ]] && exit 0
    [[ "$(cat "$FAKE_LAUNCHCTL_LOADED_STATE")" = false ]] && { printf 'Could not find service\\n' >&2; exit 113; }
    exit 1
    ;;
  print-disabled)
    [[ -f "$FAKE_LAUNCHCTL_DISABLED_STATE" ]] || printf '%s' "$FAKE_LAUNCHCTL_DISABLED" >"$FAKE_LAUNCHCTL_DISABLED_STATE"
    disabled="$(cat "$FAKE_LAUNCHCTL_DISABLED_STATE")"
    [[ "$disabled" = error ]] && exit 1
    printf 'disabled services = {\\n'
    [[ "$disabled" = true || "$disabled" = false ]] &&
      printf '  "com.kevinyoung.ace-hunter.collect-x" => %s\\n' "$disabled"
    printf '}\\n'
    ;;
  bootout)
    [[ "$FAKE_LAUNCHCTL_BOOTOUT_FAILS" = true ]] && exit 1
    printf 'false' >"$FAKE_LAUNCHCTL_LOADED_STATE"
    ;;
  bootstrap)
    [[ -f "$FAKE_LAUNCHCTL_DISABLED_STATE" && "$(cat "$FAKE_LAUNCHCTL_DISABLED_STATE")" = true ]] && exit 5
    printf 'true' >"$FAKE_LAUNCHCTL_LOADED_STATE"
    ;;
  enable)
    [[ "$FAKE_LAUNCHCTL_ENABLE_FAILS" = true ]] && exit 7
    printf 'false' >"$FAKE_LAUNCHCTL_DISABLED_STATE"
    ;;
  disable) printf 'true' >"$FAKE_LAUNCHCTL_DISABLED_STATE";;
esac
`, { mode: 0o755 });
  await chmod(launchctl, 0o755);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("restores a loaded and enabled prior LaunchAgent exactly and makes rollback idempotent", async () => {
  const prior = join(app, "releases", "prior");
  const next = join(app, "releases", "next");
  await Promise.all([mkdir(join(prior, "skills", "ace-hunter"), { recursive: true }), mkdir(next, { recursive: true })]);
  await symlink(prior, join(app, "current"));
  await writeFile(join(app, "bin", "ace-hunter"), "prior-wrapper\n", { mode: 0o755 });
  await symlink(join(prior, "skills", "ace-hunter"), join(codex, "skills", "ace-hunter"));
  await writeFile(join(app, "bin", "keychain-secret"), "prior-helper\n", { mode: 0o700 });
  await writeFile(join(app, "runtime-credentials.env"), "prior-credentials\n", { mode: 0o600 });
  await writeFile(join(app, "runtime.env"), "prior-runtime\n", { mode: 0o600 });
  await writeFile(join(app, "scheduler.conf"), `RELEASE_ROOT=${prior}\n`, { mode: 0o600 });
  const agent = join(home, "Library", "LaunchAgents", "com.kevinyoung.ace-hunter.collect-x.plist");
  await writeFile(agent, `prior=${prior}\n`, { mode: 0o600 });

  await run("begin", { loaded: "true", disabled: "false" });
  const state = JSON.parse(await readFile(join(tx, "state.json"), "utf8"));
  expect(state).toMatchObject({
      version: 3,
    launchd: { loaded: true, disabledOverride: false },
    externalDatabase: { passwordState: "not_modified" },
  });
  expect((await stat(tx)).mode & 0o777).toBe(0o700);
  expect((await stat(join(tx, "state.json"))).mode & 0o777).toBe(0o600);
  expect((await stat(join(tx, "agent.bytes"))).mode & 0o777).toBe(0o600);
  await Promise.all([rm(join(app, "current")), rm(join(codex, "skills", "ace-hunter"))]);
  await symlink(next, join(app, "current"));
  await symlink(join(next, "skills"), join(codex, "skills", "ace-hunter"));
  await writeFile(join(app, "bin", "ace-hunter"), "next-wrapper\n");
  await writeFile(join(app, "runtime-credentials.env"), "next-credentials\n");
  await writeFile(join(app, "runtime.env"), "next-runtime\n");
  await writeFile(join(app, "scheduler.conf"), `RELEASE_ROOT=${next}\n`);
  await writeFile(agent, `next=${next}\n`);

  await run("rollback", { loaded: "true", disabled: "false" });

  expect(await readlink(join(app, "current"))).toBe(prior);
  expect(await readFile(join(app, "bin", "ace-hunter"), "utf8")).toBe("prior-wrapper\n");
  expect(await readFile(join(app, "runtime-credentials.env"), "utf8")).toBe("prior-credentials\n");
  expect(await readFile(join(app, "runtime.env"), "utf8")).toBe("prior-runtime\n");
  expect(await readlink(join(codex, "skills", "ace-hunter"))).toBe(join(prior, "skills", "ace-hunter"));
  expect(await readFile(join(app, "scheduler.conf"), "utf8")).toBe(`RELEASE_ROOT=${prior}\n`);
  expect(await readFile(agent, "utf8")).toBe(`prior=${prior}\n`);
  const callsAfterFirstRollback = await launchctlCalls();
  expect(callsAfterFirstRollback).toEqual([
    `print gui/${currentUid}/com.kevinyoung.ace-hunter.collect-x`,
    `print-disabled gui/${currentUid}`,
    `bootout gui/${currentUid} ${agent}`,
    `print gui/${currentUid}/com.kevinyoung.ace-hunter.collect-x`,
    `bootstrap gui/${currentUid} ${agent}`,
    `enable gui/${currentUid}/com.kevinyoung.ace-hunter.collect-x`,
    `print gui/${currentUid}/com.kevinyoung.ace-hunter.collect-x`,
    `print-disabled gui/${currentUid}`,
  ]);

  await run("rollback", { loaded: "false", disabled: "true" });
  expect(await launchctlCalls()).toEqual(callsAfterFirstRollback);
});

it("tracks external database password mutation as manual recovery state", async () => {
  await run("begin", { loaded: "false", disabled: "absent" });
  await execFile("node", ["scripts/release-transaction.mjs", "mark-external-db-modified", tx], { cwd: process.cwd(), env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}` } });
  const state = JSON.parse(await readFile(join(tx, "state.json"), "utf8"));
  expect(state.externalDatabase.passwordState).toBe("modified_requires_manual_recovery");
});

it("restores a prior plist that was unloaded and disabled without starting it", async () => {
  const agent = join(home, "Library", "LaunchAgents", "com.kevinyoung.ace-hunter.collect-x.plist");
  await writeFile(agent, "prior-disabled\n", { mode: 0o600 });
  await run("begin", { loaded: "false", disabled: "true" });
  await writeFile(agent, "new\n", { mode: 0o600 });

  await run("rollback", { loaded: "false", disabled: "true" });

  expect(await readFile(agent, "utf8")).toBe("prior-disabled\n");
  expect(await launchctlCalls()).toEqual([
    `print gui/${currentUid}/com.kevinyoung.ace-hunter.collect-x`,
    `print-disabled gui/${currentUid}`,
    `bootout gui/${currentUid} ${agent}`,
    `print gui/${currentUid}/com.kevinyoung.ace-hunter.collect-x`,
    `disable gui/${currentUid}/com.kevinyoung.ace-hunter.collect-x`,
    `print gui/${currentUid}/com.kevinyoung.ace-hunter.collect-x`,
    `print-disabled gui/${currentUid}`,
  ]);
});

it("temporarily enables a loaded disabled prior service before bootstrap, then restores disabled", async () => {
  const agent = join(home, "Library", "LaunchAgents", "com.kevinyoung.ace-hunter.collect-x.plist");
  await writeFile(agent, "prior-loaded-disabled\n", { mode: 0o600 });
  await run("begin", { loaded: "true", disabled: "true" });
  await writeFile(agent, "new\n", { mode: 0o600 });

  await run("rollback", { loaded: "true", disabled: "true" });

  expect(await readFile(agent, "utf8")).toBe("prior-loaded-disabled\n");
  expect(await launchctlCalls()).toEqual([
    `print gui/${currentUid}/com.kevinyoung.ace-hunter.collect-x`,
    `print-disabled gui/${currentUid}`,
    `bootout gui/${currentUid} ${agent}`,
    `print gui/${currentUid}/com.kevinyoung.ace-hunter.collect-x`,
    `enable gui/${currentUid}/com.kevinyoung.ace-hunter.collect-x`,
    `bootstrap gui/${currentUid} ${agent}`,
    `disable gui/${currentUid}/com.kevinyoung.ace-hunter.collect-x`,
    `print gui/${currentUid}/com.kevinyoung.ace-hunter.collect-x`,
    `print-disabled gui/${currentUid}`,
  ]);
});

it("propagates a temporary enable failure without claiming rollback completed", async () => {
  const agent = join(home, "Library", "LaunchAgents", "com.kevinyoung.ace-hunter.collect-x.plist");
  await writeFile(agent, "prior\n", { mode: 0o600 });
  await run("begin", { loaded: "true", disabled: "true" });

  await expect(run("rollback", { loaded: "true", disabled: "true", enableFails: true }))
    .rejects.toMatchObject({ stderr: expect.stringContaining("release_transaction_launchd_restore_failed") });
  const state = JSON.parse(await readFile(join(tx, "state.json"), "utf8"));
  expect(state.status).toBe("active");
});

it("removes a first install without inventing prior launchd state", async () => {
  await run("begin", { loaded: "false", disabled: "absent" });
  const agent = join(home, "Library", "LaunchAgents", "com.kevinyoung.ace-hunter.collect-x.plist");
  await writeFile(join(app, "bin", "keychain-secret"), "new-helper\n");
  await writeFile(join(app, "scheduler.conf"), "RELEASE_ROOT=next\n");
  await writeFile(agent, "next\n");

  await run("rollback", { loaded: "false", disabled: "absent" });

  await expect(readFile(join(app, "bin", "keychain-secret"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(app, "scheduler.conf"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(agent)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await launchctlCalls()).toEqual([
    `print gui/${currentUid}/com.kevinyoung.ace-hunter.collect-x`,
    `print-disabled gui/${currentUid}`,
    `bootout gui/${currentUid} ${agent}`,
    `print gui/${currentUid}/com.kevinyoung.ace-hunter.collect-x`,
    `print gui/${currentUid}/com.kevinyoung.ace-hunter.collect-x`,
    `print-disabled gui/${currentUid}`,
  ]);
});

it("fails closed when prior launchd state cannot be probed reliably", async () => {
  await expect(run("begin", { loaded: "error", disabled: "false" })).rejects.toMatchObject({
    stderr: expect.stringContaining("release_transaction_launchd_probe_failed"),
  });
});

it("fails closed when a loaded prior service has no restorable plist", async () => {
  await expect(run("begin", { loaded: "true", disabled: "absent" })).rejects.toMatchObject({
    stderr: expect.stringContaining("release_transaction_launchd_state_unrestorable"),
  });
});

it("fails closed when bootout does not actually unload the new service", async () => {
  const agent = join(home, "Library", "LaunchAgents", "com.kevinyoung.ace-hunter.collect-x.plist");
  await writeFile(agent, "prior\n", { mode: 0o600 });
  await run("begin", { loaded: "true", disabled: "false" });

  await expect(run("rollback", { loaded: "true", disabled: "false", bootoutFails: true }))
    .rejects.toMatchObject({ stderr: expect.stringContaining("release_transaction_launchd_restore_failed") });
});

async function launchctlCalls() {
  const contents = await readFile(join(root, "launchctl.log"), "utf8");
  return contents.trim().split("\n");
}

function run(
  action: "begin" | "rollback" | "commit",
  launchd: {
    loaded: "true" | "false" | "error";
    disabled: "true" | "false" | "absent" | "error";
    bootoutFails?: boolean;
    enableFails?: boolean;
  } = {
    loaded: "false", disabled: "absent",
  },
) {
  const args = action === "begin"
    ? ["scripts/release-transaction.mjs", action, tx, app, codex]
    : ["scripts/release-transaction.mjs", action, tx];
  return execFile("node", args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_LAUNCHCTL_LOG: join(root, "launchctl.log"),
      FAKE_LAUNCHCTL_LOADED: launchd.loaded,
      FAKE_LAUNCHCTL_DISABLED: launchd.disabled,
      FAKE_LAUNCHCTL_LOADED_STATE: join(root, "launchctl-loaded.state"),
      FAKE_LAUNCHCTL_DISABLED_STATE: join(root, "launchctl-disabled.state"),
      FAKE_LAUNCHCTL_BOOTOUT_FAILS: String(launchd.bootoutFails === true),
      FAKE_LAUNCHCTL_ENABLE_FAILS: String(launchd.enableFails === true),
    },
  });
}
