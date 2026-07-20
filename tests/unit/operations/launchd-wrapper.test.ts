import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

const wrapper = resolve("scripts/run-scheduled-x.sh");
const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("launchd X wrapper", () => {
  it("uses a six-hour launch agent without embedding runtime secrets", async () => {
    const plist = await readFile("ops/launchd/com.kevinyoung.ace-hunter.collect-x.plist", "utf8");
    expect(plist).toContain("<key>StartInterval</key>\n  <integer>21600</integer>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).not.toMatch(/github[_-]?token|database[_-]?url|deepseek[_-]?api[_-]?key/i);
  });

  it.each([
    ["malformed PID", "bad\n/path\n"],
    ["reboot-stale PID", `999999\n${wrapper}\n`],
    ["unrelated reused PID", `${process.pid}\n${wrapper}\n`],
  ])("recovers a %s lock and removes its own lock on success", async (_name, owner) => {
    const fixture = await makeFixture(false);
    await mkdir(fixture.lock, { recursive: true });
    await writeFile(join(fixture.lock, "owner"), owner);
    const result = await runWrapper(fixture.home);
    expect(result.code).toBe(0);
    await expect(readFile(join(fixture.lock, "owner"))).rejects.toThrow();
  });

  it("never deletes an owner file that another process may still be initializing", async () => {
    const fixture = await makeFixture(false);
    await mkdir(fixture.lock, { recursive: true });
    const result = await runWrapper(fixture.home);
    expect(result.code).toBe(0);
    expect((await stat(fixture.lock)).isDirectory()).toBe(true);
  });

  it("recovers an ownerless lock after the bounded initialization window", async () => {
    const fixture = await makeFixture(false);
    await mkdir(fixture.lock, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    await utimes(fixture.lock, old, old);
    const result = await runWrapper(fixture.home);
    expect(result.code).toBe(0);
    await expect(stat(fixture.lock)).rejects.toThrow();
  });

  it("exports a persisted proxy whitelist to the Twitter preflight child", async () => {
    const proxy = "http://127.0.0.1:18443";
    const fixture = await makeFixture(false, proxy);
    const result = await runWrapper(fixture.home, true);
    expect(result.code).toBe(0);
    expect(await readFile(join(fixture.home, "proxy-seen"), "utf8")).toBe(proxy);
  });

  it("recovers from a removed persisted Node path with the current Node 22", async () => {
    const fixture = await makeFixture(false, undefined, true);
    const result = await runWrapper(fixture.home);
    expect(result.code).toBe(0);
    expect((await readFile(fixture.nodeLog, "utf8")).trim().split("\n").length).toBeGreaterThan(0);
  });

  it("treats an active same-wrapper PID as overlap and trap-cleans the owner's lock", async () => {
    const fixture = await makeFixture(true);
    const first = spawn("/bin/bash", [wrapper], { env: { ...process.env, HOME: fixture.home }, stdio: "ignore" });
    await waitFor(async () => (await readFile(join(fixture.lock, "owner"), "utf8")).startsWith(String(first.pid)));
    const second = await runWrapper(fixture.home);
    expect(second.code).toBe(0);
    expect(await readFile(join(fixture.lock, "owner"), "utf8")).toContain(String(first.pid));
    first.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => first.once("close", () => resolvePromise()));
    await expect(readFile(join(fixture.lock, "owner"))).rejects.toThrow();
  }, 10_000);
});

async function makeFixture(slowPreflight: boolean, proxy?: string, stalePersistedNode = false) {
  const home = await mkdtemp(join(tmpdir(), "ace-hunter-launchd-"));
  temporary.push(home);
  const app = join(home, "Library/Application Support/AceHunter");
  const bin = join(home, "bin");
  const release = join(home, "release");
  await mkdir(join(app, "run"), { recursive: true });
  await mkdir(join(release, "dist/scripts"), { recursive: true });
  await mkdir(join(release, "dist/src/cli"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(join(release, "scripts"), { recursive: true });
  await writeFile(join(release, "scripts", "resolve-node22.sh"), await readFile("scripts/resolve-node22.sh", "utf8"), { mode: 0o755 });
  const node = join(bin, "node");
  const keychain = join(bin, "keychain");
  const twitter = join(bin, "twitter");
  const nodeLog = join(home, "node.log");
  await writeFile(node, `#!/bin/bash\nif [[ "\${1:-}" = --version ]]; then printf 'v22.17.0\\n'; exit 0; fi\nprintf 'invoke\\n' >>"$HOME/node.log"\ncase "$1" in *assert-twitter-preflight.js) printf '%s' "\${HTTPS_PROXY:-missing}" >"$HOME/proxy-seen"; ${slowPreflight ? "sleep 30" : ":"};; esac\nexit 0\n`);
  await writeFile(keychain, "#!/bin/bash\nprintf value\n");
  await writeFile(twitter, "#!/bin/bash\nexit 0\n");
  await Promise.all([node, keychain, twitter].map((path) => chmod(path, 0o700)));
  await writeFile(join(app, "scheduler.conf"), [
    `NODE_PATH=${quote(stalePersistedNode ? join(bin, "removed-node") : node)}`,
    `TWITTER_CLI_PATH=${quote(twitter)}`,
    `KEYCHAIN_HELPER=${quote(keychain)}`,
    `RELEASE_ROOT=${quote(release)}`,
    ...(proxy === undefined ? [] : [`HTTPS_PROXY=${quote(proxy)}`]),
    "",
  ].join("\n"), { mode: 0o600 });
  return { home, lock: join(app, "run/collect-x.lock"), nodeLog };
}

function runWrapper(home: string, stripProxy = false): Promise<{ code: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${join(home, "bin")}:${process.env.PATH}` };
    if (stripProxy) {
      for (const name of [
        "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
        "http_proxy", "https_proxy", "no_proxy", "all_proxy",
      ]) delete env[name];
    }
    const child = spawn("/bin/bash", [wrapper], { env, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code }));
  });
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch { /* not ready */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error("timed_out");
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
