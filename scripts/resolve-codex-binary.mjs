import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import process from "node:process";

const minimumText = "0.145.0-alpha.18";
const minimum = parseVersion(minimumText);

try {
  const explicit = process.env.ACE_HUNTER_CODEX_BINARY;
  if (explicit) {
    if (!isAbsolute(explicit)) fail("codex_binary_must_be_absolute");
    const candidate = inspect(explicit);
    if (!candidate) fail("codex_binary_invalid");
    if (compareVersions(candidate.version, minimum) < 0) {
      fail(`codex_binary_too_old actual=${candidate.version.text} minimum=${minimumText}`);
    }
    process.stdout.write(`${candidate.path}\n`);
  } else {
    const appBinary = process.env.ACE_HUNTER_CODEX_APP_BINARY ??
      "/Applications/ChatGPT.app/Contents/Resources/codex";
    const candidates = [appBinary, ...findAllOnPath("codex")]
      .filter((path) => path !== undefined)
      .map((path) => inspect(path))
      .filter((candidate) => candidate !== undefined);
    const unique = [...new Map(candidates.map((candidate) => [candidate.path, candidate])).values()];
    const eligible = unique
      .filter((candidate) => compareVersions(candidate.version, minimum) >= 0)
      .sort((left, right) => compareVersions(right.version, left.version));
    if (!eligible[0]) fail(`codex_binary_unavailable minimum=${minimumText}`);
    process.stdout.write(`${eligible[0].path}\n`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "codex_binary_resolution_failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function inspect(path) {
  try {
    accessSync(path, constants.X_OK);
    const resolved = realpathSync(path);
    const result = spawnSync(resolved, ["--version"], {
      encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0 || result.error) return undefined;
    const version = parseVersion(result.stdout.trim());
    return { path: resolved, version };
  } catch {
    return undefined;
  }
}

function findAllOnPath(name) {
  const candidates = [];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      candidates.push(candidate);
    } catch {
      // Keep searching.
    }
  }
  return candidates;
}

function parseVersion(value) {
  const match = value.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\s|$)/u);
  if (!match) throw new Error("codex_binary_version_invalid");
  return {
    text: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}`,
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

function fail(message) {
  throw new Error(message);
}
