import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex release binary resolution", () => {
  it("prefers the newer ChatGPT Codex over an older PATH binary", async () => {
    const root = await temporaryRoot();
    const pathCodex = await fakeCodex(join(root, "path", "codex"), "0.142.0");
    const appCodex = await fakeCodex(join(root, "app", "codex"), "0.145.0-alpha.18");

    const resolved = resolve({
      PATH: `${join(root, "path")}:/usr/bin:/bin`,
      ACE_HUNTER_CODEX_APP_BINARY: appCodex,
    });

    expect(resolved).toBe(`${await realpath(appCodex)}\n`);
    expect(pathCodex).not.toBe(appCodex);
  });

  it("keeps searching PATH when an earlier Codex is too old", async () => {
    const root = await temporaryRoot();
    await fakeCodex(join(root, "old", "codex"), "0.142.0");
    const compatible = await fakeCodex(join(root, "compatible", "codex"), "0.146.0");
    const appCodex = await fakeCodex(join(root, "app", "codex"), "0.144.0");

    const resolved = resolve({
      PATH: `${join(root, "old")}:${join(root, "compatible")}:/usr/bin:/bin`,
      ACE_HUNTER_CODEX_APP_BINARY: appCodex,
    });

    expect(resolved).toBe(`${await realpath(compatible)}\n`);
  });

  it("honors an explicit absolute executable and validates its version", async () => {
    const root = await temporaryRoot();
    const explicit = await fakeCodex(join(root, "explicit", "codex"), "0.146.0");
    const appCodex = await fakeCodex(join(root, "app", "codex"), "0.147.0");

    expect(resolve({
      PATH: "/usr/bin:/bin",
      ACE_HUNTER_CODEX_BINARY: explicit,
      ACE_HUNTER_CODEX_APP_BINARY: appCodex,
    })).toBe(`${await realpath(explicit)}\n`);
  });

  it("rejects an explicit outdated binary with a deterministic diagnostic", async () => {
    const root = await temporaryRoot();
    const explicit = await fakeCodex(join(root, "explicit", "codex"), "0.142.0");

    expect(() => resolve({ PATH: "/usr/bin:/bin", ACE_HUNTER_CODEX_BINARY: explicit }))
      .toThrow(/codex_binary_too_old actual=0\.142\.0 minimum=0\.145\.0-alpha\.18/u);
  });

  it("fails clearly when no discovered Codex satisfies the minimum", async () => {
    const root = await temporaryRoot();
    await fakeCodex(join(root, "path", "codex"), "0.142.0");
    const appCodex = await fakeCodex(join(root, "app", "codex"), "0.144.0");

    expect(() => resolve({
      PATH: `${join(root, "path")}:/usr/bin:/bin`,
      ACE_HUNTER_CODEX_APP_BINARY: appCodex,
    })).toThrow(/codex_binary_unavailable minimum=0\.145\.0-alpha\.18/u);
  });
});

function resolve(overrides: NodeJS.ProcessEnv) {
  return execFileSync(process.execPath, ["scripts/resolve-codex-binary.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...overrides },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "ace-codex-resolver-"));
  roots.push(root);
  return root;
}

async function fakeCodex(path: string, version: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`);
  await chmod(path, 0o755);
  return path;
}
