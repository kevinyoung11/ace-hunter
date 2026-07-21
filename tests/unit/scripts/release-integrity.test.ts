import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const sha = "b".repeat(40);
let root: string;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ace-hunter-release-integrity-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("seals and re-verifies immutable release content including safe internal symlinks", async () => {
  const release = join(root, "release");
  await mkdir(join(release, "bin"), { recursive: true });
  await writeFile(join(release, "bin", "entry.js"), "export {};\n");
  await symlink("entry.js", join(release, "bin", "entry-link.js"));
  await run("seal", release, sha);
  const trusted = (await runDigest(release)).stdout.trim();
  await expect(run("verify", release, sha, trusted)).resolves.toMatchObject({ stdout: "release_integrity_verified\n" });
});

it("rejects reused release content changed after sealing", async () => {
  const release = join(root, "release");
  await mkdir(release);
  await writeFile(join(release, "app.js"), "original\n");
  await run("seal", release, sha);
  const trusted = (await runDigest(release)).stdout.trim();
  await writeFile(join(release, "app.js"), "tampered\n");
  await expect(run("verify", release, sha, trusted)).rejects.toMatchObject({
    stderr: expect.stringContaining("release_trusted_digest_mismatch"),
  });
});

it("rejects content and manifest tampering together", async () => {
  const release = join(root, "release");
  await mkdir(release);
  await writeFile(join(release, "app.js"), "original\n");
  await run("seal", release, sha);
  const trusted = (await runDigest(release)).stdout.trim();
  await writeFile(join(release, "app.js"), "tampered\n");
  const tamperedDigest = (await runDigest(release)).stdout.trim();
  await writeFile(join(release, "release-manifest.json"),
    `${JSON.stringify({ sha, content_sha256: tamperedDigest })}\n`);
  await expect(run("verify", release, sha, trusted)).rejects.toMatchObject({
    stderr: expect.stringContaining("release_trusted_digest_mismatch"),
  });
});

it("rejects a release root symlink and an escaping content symlink", async () => {
  const realRelease = join(root, "real-release");
  const linkedRelease = join(root, "linked-release");
  await mkdir(realRelease);
  await writeFile(join(root, "outside"), "secret\n");
  await symlink(realRelease, linkedRelease);
  await expect(run("seal", linkedRelease, sha)).rejects.toMatchObject({
    stderr: expect.stringContaining("release_path_invalid"),
  });
  await symlink("../outside", join(realRelease, "escape"));
  await expect(run("seal", realRelease, sha)).rejects.toMatchObject({
    stderr: expect.stringContaining("release_symlink_escape"),
  });
});

it("enforces the exact argument contract for every integrity action", async () => {
  const release = join(root, "release");
  await mkdir(release);
  const digest = "c".repeat(64);
  await expect(execFile("node", ["scripts/release-integrity.mjs", "digest", release, "extra"], { cwd: process.cwd() }))
    .rejects.toMatchObject({ stderr: expect.stringContaining("release_integrity_usage_error") });
  await expect(execFile("node", ["scripts/release-integrity.mjs", "seal", release, sha, "extra"], { cwd: process.cwd() }))
    .rejects.toMatchObject({ stderr: expect.stringContaining("release_integrity_usage_error") });
  await expect(execFile("node", ["scripts/release-integrity.mjs", "verify", release, sha], { cwd: process.cwd() }))
    .rejects.toMatchObject({ stderr: expect.stringContaining("release_integrity_usage_error") });
  await expect(execFile("node", ["scripts/release-integrity.mjs", "verify", release, sha, digest, "extra"], { cwd: process.cwd() }))
    .rejects.toMatchObject({ stderr: expect.stringContaining("release_integrity_usage_error") });
});

function run(action: "seal" | "verify", release: string, expectedSha: string, trusted?: string) {
  return execFile("node", ["scripts/release-integrity.mjs", action, release, expectedSha, ...(trusted ? [trusted] : [])], { cwd: process.cwd() });
}

function runDigest(release: string) {
  return execFile("node", ["scripts/release-integrity.mjs", "digest", release], { cwd: process.cwd() });
}
