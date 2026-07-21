import { createHash } from "node:crypto";
import {
  lstat, opendir, readFile, readlink, realpath, rename, rm, writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const [action, releaseArg, expectedSha, trustedDigest] = args;
const manifestName = "release-manifest.json";

try {
  const expectedArgCount = action === "digest" ? 2 : action === "seal" ? 3 : action === "verify" ? 4 : -1;
  if (args.length !== expectedArgCount) throw new Error("release_integrity_usage_error");
  if (!(["seal", "verify", "digest"].includes(action)) || !isAbsolute(releaseArg ?? "") ||
      (action !== "digest" && !/^[a-f0-9]{40}$/u.test(expectedSha ?? "")) ||
      (action === "verify" && !/^[a-f0-9]{64}$/u.test(trustedDigest ?? ""))) {
    throw new Error("release_integrity_usage_error");
  }
  const release = await validateRoot(resolve(releaseArg));
  if (action === "digest") {
    process.stdout.write(`${await hashTree(release)}\n`);
  } else if (action === "seal") {
    await rm(join(release, manifestName), { force: true });
    const contentSha256 = await hashTree(release);
    const manifest = { sha: expectedSha, content_sha256: contentSha256 };
    const temporary = join(release, `.${manifestName}.${process.pid}`);
    await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, join(release, manifestName));
    process.stdout.write("release_integrity_sealed\n");
  } else {
    const manifestPath = join(release, manifestName);
    const manifestStat = await lstat(manifestPath).catch(() => null);
    if (manifestStat === null || !manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      throw new Error("release_manifest_invalid");
    }
    const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
        Object.keys(parsed).sort().join(",") !== "content_sha256,sha" ||
        parsed.sha !== expectedSha || !/^[a-f0-9]{64}$/u.test(parsed.content_sha256)) {
      throw new Error("release_manifest_invalid");
    }
    const computedDigest = await hashTree(release);
    if (computedDigest !== trustedDigest) throw new Error("release_trusted_digest_mismatch");
    if (computedDigest !== parsed.content_sha256) throw new Error("release_integrity_mismatch");
    process.stdout.write("release_integrity_verified\n");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "release_integrity_failed"}\n`);
  process.exitCode = 1;
}

async function validateRoot(release) {
  const value = await lstat(release).catch(() => null);
  if (value === null || !value.isDirectory() || value.isSymbolicLink()) {
    throw new Error("release_path_invalid");
  }
  return realpath(release);
}

async function hashTree(root) {
  const hash = createHash("sha256");
  await visit(root, "");
  return hash.digest("hex");

  async function visit(absolute, relativePath) {
    const entries = [];
    const directory = await opendir(absolute);
    for await (const entry of directory) entries.push(entry.name);
    entries.sort();
    for (const name of entries) {
      if (relativePath === "" && name === manifestName) continue;
      const path = join(absolute, name);
      const childRelative = relativePath === "" ? name : `${relativePath}/${name}`;
      const stat = await lstat(path);
      if (stat.isDirectory()) {
        hash.update(frame("directory", childRelative, stat.mode & 0o777));
        await visit(path, childRelative);
      } else if (stat.isFile()) {
        const fileHash = createHash("sha256").update(await readFile(path)).digest("hex");
        hash.update(frame("file", childRelative, stat.mode & 0o777, fileHash));
      } else if (stat.isSymbolicLink()) {
        const target = await readlink(path);
        const resolved = await realpath(path).catch(() => "");
        const escaped = resolved === "" || (resolved !== root && !resolved.startsWith(`${root}${sep}`));
        if (escaped || relative(root, resolved).startsWith(`..${sep}`)) throw new Error("release_symlink_escape");
        hash.update(frame("symlink", childRelative, stat.mode & 0o777, target));
      } else {
        throw new Error("release_content_invalid");
      }
    }
  }
}

function frame(type, path, mode, value = "") {
  return `${JSON.stringify([type, path, mode, value])}\n`;
}
