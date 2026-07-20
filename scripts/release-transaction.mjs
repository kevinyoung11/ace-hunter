import { spawnSync } from "node:child_process";
import {
  chmod, copyFile, lstat, mkdir, readFile, readlink, rename, rm, stat, symlink, writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import process from "node:process";

const [action, transaction, appDir, codexHome] = process.argv.slice(2);
const agentName = "com.kevinyoung.ace-hunter.collect-x.plist";
const agentLabel = agentName.replace(/\.plist$/u, "");

try {
  if (!isAbsolute(transaction ?? "") || !["begin", "verify", "rollback", "commit", "launchd-mode", "mark-external-db-modified"].includes(action)) {
    throw new Error("release_transaction_usage_error");
  }
  if (action === "begin") await begin();
  else if (action === "verify") await loadState("active");
  else if (action === "rollback") await rollback();
  else if (action === "commit") await commit();
  else if (action === "mark-external-db-modified") await markExternalDbModified();
  else {
    const state = await loadState("active");
    process.stdout.write(state.launchd.disabledOverride === true ? "enable\n" : "preserve\n");
  }
  if (action !== "launchd-mode") process.stdout.write(`release_transaction_${action}_passed\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "release_transaction_failed"}\n`);
  process.exitCode = 1;
}

async function begin() {
  if (!isAbsolute(appDir ?? "") || !isAbsolute(codexHome ?? "")) throw new Error("release_transaction_usage_error");
  await assertOwnerOnly(dirname(transaction));
  await mkdir(transaction, { mode: 0o700 });
  const home = process.env.HOME;
  if (!home || !isAbsolute(home)) throw new Error("release_transaction_home_invalid");
  const paths = {
    current: join(appDir, "current"),
    wrapper: join(appDir, "bin", "ace-hunter"),
    skill: join(codexHome, "skills", "ace-hunter"),
    helper: join(appDir, "bin", "keychain-secret"),
    credentials: join(appDir, "runtime-credentials.env"),
    runtimeEnv: join(appDir, "runtime.env"),
    config: join(appDir, "scheduler.conf"),
    agent: join(home, "Library", "LaunchAgents", agentName),
  };
  const kinds = { current: "link", wrapper: "file", skill: "link", helper: "file", credentials: "file", runtimeEnv: "file", config: "file", agent: "file" };
  const artifacts = {};
  for (const [name, path] of Object.entries(paths)) {
    artifacts[name] = await snapshot(name, path, kinds[name]);
  }
  const launchd = probeLaunchd(`gui/${process.getuid?.()}`);
  if (launchd.loaded && artifacts.agent.state !== "file") {
    throw new Error("release_transaction_launchd_state_unrestorable");
  }
  // Local artifacts are rollback-safe; external database role passwords are
  // intentionally not claimed reversible by this transaction.
  await writeState({ version: 3, status: "active", uid: process.getuid?.(), paths, artifacts, launchd,
    externalDatabase: { passwordState: "not_modified" } });
}

function probeLaunchd(domain) {
  const service = `${domain}/${agentLabel}`;
  const loadedProbe = spawnSync("launchctl", ["print", service], { encoding: "utf8" });
  if (loadedProbe.error || ![0, 113].includes(loadedProbe.status)) {
    throw new Error("release_transaction_launchd_probe_failed");
  }
  const disabledProbe = spawnSync("launchctl", ["print-disabled", domain], { encoding: "utf8" });
  if (disabledProbe.error || disabledProbe.status !== 0 ||
      !/^\s*disabled services\s*=\s*\{[\s\S]*\}\s*$/u.test(disabledProbe.stdout)) {
    throw new Error("release_transaction_launchd_probe_failed");
  }
  const escapedLabel = agentLabel.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matches = [...disabledProbe.stdout.matchAll(new RegExp(`^\\s*"${escapedLabel}"\\s*=>\\s*(true|false)\\s*$`, "gmu"))];
  if (matches.length > 1) throw new Error("release_transaction_launchd_probe_failed");
  return {
    loaded: loadedProbe.status === 0,
    disabledOverride: matches.length === 0 ? null : matches[0][1] === "true",
  };
}

async function snapshot(name, path, expectedKind) {
  const value = await lstat(path).catch(() => null);
  if (value === null) return { state: "absent" };
  const valid = expectedKind === "link" ? value.isSymbolicLink() : value.isFile() && !value.isSymbolicLink();
  if (!valid) throw new Error(`release_transaction_conflict:${name}`);
  if (expectedKind === "link") return { state: "link", target: await readlink(path) };
  const backup = join(transaction, `${name}.bytes`);
  await copyFile(path, backup);
  await chmod(backup, 0o600);
  return { state: "file", mode: value.mode & 0o777, backup };
}

async function rollback() {
  const state = await loadState();
  if (state.status === "rolled_back") return;
  if (state.status !== "active") throw new Error("release_transaction_not_active");
  const domain = `gui/${process.getuid?.()}`;
  spawnSync("launchctl", ["bootout", domain, state.paths.agent], { stdio: "ignore" });
  assertLaunchdLoaded(domain, false);
  for (const name of ["current", "wrapper", "skill", "helper", "credentials", "runtimeEnv", "config", "agent"]) {
    await rm(state.paths[name], { recursive: false, force: true });
  }
  for (const name of ["current", "wrapper", "skill", "helper", "credentials", "runtimeEnv", "config", "agent"]) {
    const artifact = state.artifacts[name];
    if (artifact.state === "link") await restoreLink(state.paths[name], artifact.target);
    if (artifact.state === "file") await restoreFile(state.paths[name], artifact.backup, artifact.mode);
  }
  if (state.artifacts.agent.state === "file") {
    if (state.launchd.loaded) {
      if (state.launchd.disabledOverride === true) {
        const enabled = spawnSync("launchctl", ["enable", `${domain}/${agentLabel}`], { stdio: "ignore" });
        if (enabled.status !== 0) throw new Error("release_transaction_launchd_restore_failed");
      }
      const bootstrap = spawnSync("launchctl", ["bootstrap", domain, state.paths.agent], { stdio: "ignore" });
      if (bootstrap.status !== 0) throw new Error("release_transaction_launchd_restore_failed");
    }
  }
  if (state.launchd.disabledOverride !== null) {
    const operation = state.launchd.disabledOverride ? "disable" : "enable";
    const restored = spawnSync("launchctl", [operation, `${domain}/${agentLabel}`], { stdio: "ignore" });
    if (restored.status !== 0) throw new Error("release_transaction_launchd_restore_failed");
  }
  const restoredLaunchd = probeLaunchd(domain);
  if (restoredLaunchd.loaded !== state.launchd.loaded ||
      restoredLaunchd.disabledOverride !== state.launchd.disabledOverride) {
    throw new Error("release_transaction_launchd_restore_failed");
  }
  state.status = "rolled_back";
  await writeState(state);
}

function assertLaunchdLoaded(domain, expected) {
  const probe = spawnSync("launchctl", ["print", `${domain}/${agentLabel}`], { encoding: "utf8" });
  if (probe.error || ![0, 113].includes(probe.status) || (probe.status === 0) !== expected) {
    throw new Error("release_transaction_launchd_restore_failed");
  }
}

async function commit() {
  const state = await loadState();
  if (state.status === "committed") return;
  if (state.status !== "active") throw new Error("release_transaction_not_active");
  state.status = "committed";
  await writeState(state);
}

async function markExternalDbModified() {
  const state = await loadState("active");
  state.externalDatabase.passwordState = "modified_requires_manual_recovery";
  await writeState(state);
}

async function loadState(expectedStatus) {
  await assertOwnerOnly(transaction);
  const statePath = join(transaction, "state.json");
  const value = await lstat(statePath);
  if (!value.isFile() || value.isSymbolicLink() || value.uid !== process.getuid?.() || (value.mode & 0o077) !== 0) {
    throw new Error("release_transaction_invalid");
  }
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const validDisabledOverride = state.launchd?.disabledOverride === null ||
    typeof state.launchd?.disabledOverride === "boolean";
  if (state.version !== 3 || state.uid !== process.getuid?.() || typeof state.paths !== "object" ||
      typeof state.artifacts !== "object" || typeof state.status !== "string" ||
      typeof state.launchd?.loaded !== "boolean" || !validDisabledOverride ||
      !["not_modified", "modified_requires_manual_recovery"].includes(state.externalDatabase?.passwordState)) throw new Error("release_transaction_invalid");
  if (expectedStatus !== undefined && state.status !== expectedStatus) throw new Error("release_transaction_not_active");
  return state;
}

async function writeState(state) {
  const temporary = join(transaction, `.state.${process.pid}`);
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, join(transaction, "state.json"));
}

async function restoreLink(path, target) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.rollback.${process.pid}`;
  await symlink(target, temporary);
  await rename(temporary, path);
}

async function restoreFile(path, backup, mode) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.rollback.${process.pid}`;
  await copyFile(backup, temporary);
  await chmod(temporary, mode);
  await rename(temporary, path);
}

async function assertOwnerOnly(path) {
  const value = await stat(path);
  if (!value.isDirectory() || value.uid !== process.getuid?.() || (value.mode & 0o077) !== 0) {
    throw new Error("release_transaction_permissions_invalid");
  }
}
