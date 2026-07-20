import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);

it("smoke-tests list with its actual option-free CLI contract", async () => {
  const script = await readFile("ops/launchd/deploy-main.sh", "utf8");
  expect(script).toContain('"${candidate}/dist/src/cli/index.js" list >/dev/null');
  expect(script).toContain('"$wrapper" list >/dev/null');
  expect(script).not.toMatch(/\blist --format\b/);
});

it("builds the immutable release with npm and lifecycle PATH from the selected Node 22 installation", async () => {
  const script = await readFile("ops/launchd/deploy-main.sh", "utf8");
  expect(script).toContain("node22_npm_not_found");
  expect(script).toContain('PATH="${node_bin_dir}:$PATH" "$node_path" "$npm_cli" ci');
  expect(script).not.toContain("npm ci");
});

it("persists the resolver-selected stable Node path in the user wrapper", async () => {
  const script = await readFile("ops/launchd/deploy-main.sh", "utf8");
  expect(script).toContain('node_path="$("${repo_root}/scripts/resolve-node22.sh")"');
  expect(script).toContain('printf \'NODE_PATH=%q exec %q "$@"\\n\' "$node_path"');
  expect(script).not.toContain('node_path="$(realpath');
});

describe("post-switch minimal signal smokes", () => {
  it("captures every deployment-managed JSON route for content validation with DB-only env", async () => {
    const script = await readFile("ops/launchd/deploy-main.sh", "utf8");
    const commands = [
      ["potential --format json", "potential.json"],
      ["trending daily --format json", "daily.json"],
      ["trending weekly --format json", "weekly.json"],
      ["trending monthly --format json", "monthly.json"],
      ["trending all --format json", "all.json"],
    ];

    for (const [command, output] of commands) {
      expect(script).toContain(`ACE_HUNTER_ENV_FILE="$readonly_env" "$wrapper" ${command} >"${"${smoke_dir}"}/${output}"`);
    }
    expect(script).toContain('env -i HOME="$HOME" PATH="/usr/bin:/bin" NODE_PATH="$node_path"');
    expect(script).toContain('ACE_HUNTER_RUNTIME_DATABASE_URL');
    expect(script).toContain('validate-signal-release.js');
    expect(script).toContain('validate-signal-release.js" allow-empty');
    expect(script).not.toContain('ACE_HUNTER_ENV_FILE="$live_env" "$wrapper" potential');
  });

  it("keeps every new smoke inside the transaction that restores all switched artifacts", async () => {
    const script = await readFile("ops/launchd/deploy-main.sh", "utf8");
    const switchFinished = script.indexOf('atomic_replace "${skill_link}.new.$$" "$skill_link"');
    const firstSignalSmoke = script.indexOf('ACE_HUNTER_ENV_FILE="$readonly_env" "$wrapper" potential --format json');
    const transactionCommitted = script.indexOf("trap - ERR HUP INT TERM", firstSignalSmoke);

    expect(switchFinished).toBeGreaterThan(-1);
    expect(firstSignalSmoke).toBeGreaterThan(switchFinished);
    expect(transactionCommitted).toBeGreaterThan(firstSignalSmoke);
    expect(script.indexOf("trap 'rollback_exit $?' ERR")).toBeLessThan(firstSignalSmoke);
    expect(script).toContain('"$node_path" "$transaction_helper" rollback "$transaction"');
    expect(script).not.toMatch(/set\s+-[^\n]*x/u);
  });

  it("verifies a sealed non-symlink immutable release before first use and reuse", async () => {
    const script = await readFile("ops/launchd/deploy-main.sh", "utf8");
    expect(script).toContain('"$integrity_helper" seal "$candidate_tmp" "$main_sha"');
    expect(script).toContain('"$integrity_helper" verify "$candidate_tmp" "$main_sha"');
    expect(script).toContain('"$integrity_helper" verify "$candidate" "$main_sha"');
    expect(script).toContain('[[ -d "$candidate" && ! -L "$candidate" ]]');
  });

  it("restores the prior current, wrapper, and Skill link when a new smoke fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-hunter-deploy-rollback-"));
    const home = join(root, "home");
    const app = join(home, "Library", "Application Support", "AceHunter");
    const releases = join(app, "releases");
    const sha = "a".repeat(40);
    const prior = join(releases, "prior");
    const candidate = join(releases, sha);
    const codexHome = join(root, "codex");
    const wrapper = join(app, "bin", "ace-hunter");
    const skillLink = join(codexHome, "skills", "ace-hunter");
    const liveEnv = join(root, "runtime.env");
    const fakeBin = join(root, "bin");
    const transaction = join(root, "owner-only", "release-rollback");
    const priorWrapper = "#!/bin/bash\nprintf 'prior wrapper\\n'\n";
    try {
      await Promise.all([
        mkdir(join(prior, "skills", "ace-hunter"), { recursive: true }),
        mkdir(join(candidate, "dist", "src", "cli"), { recursive: true }),
        mkdir(join(candidate, "scripts"), { recursive: true }),
        mkdir(join(candidate, "skills", "ace-hunter"), { recursive: true }),
        mkdir(join(app, "bin"), { recursive: true }),
        mkdir(join(codexHome, "skills"), { recursive: true }),
        mkdir(fakeBin, { recursive: true }),
        mkdir(join(root, "owner-only"), { recursive: true, mode: 0o700 }),
      ]);
      await writeFile(liveEnv, [
        "ACE_HUNTER_RUNTIME_DATABASE_URL=postgres://runtime",
        "ACE_HUNTER_GITHUB_TOKEN=top-secret-github",
        "ACE_HUNTER_DEEPSEEK_API_KEY=top-secret-model",
        "ACE_HUNTER_USER_ID=00000000-0000-4000-8000-000000000001",
        "",
      ].join("\n"), { mode: 0o600 });
      await writeFile(wrapper, priorWrapper, { mode: 0o755 });
      await symlink(prior, join(app, "current"));
      await symlink(join(prior, "skills", "ace-hunter"), skillLink);
      await writeFile(join(candidate, "dist", "src", "cli", "index.js"),
        "import{readFileSync,statSync}from'node:fs';const c=process.argv[2];if(c==='potential'||c==='trending'){if(process.env.ACE_HUNTER_GITHUB_TOKEN||process.env.ACE_HUNTER_DEEPSEEK_API_KEY||process.env.ACE_HUNTER_USER_ID)process.exit(31);const p=process.env.ACE_HUNTER_ENV_FILE;const x=readFileSync(p,'utf8');if(!/^ACE_HUNTER_RUNTIME_DATABASE_URL=/.test(x)||/TOKEN|API_KEY|USER_ID/.test(x)||(statSync(p).mode&0o77)!==0)process.exit(32)}if(c==='trending'&&process.argv[3]==='weekly')process.exit(23);\n");
      await writeFile(join(candidate, "scripts", "validate-skill.mjs"), "process.exit(0);\n");
      await mkdir(join(candidate, "dist", "scripts"), { recursive: true });
      await writeFile(join(candidate, "dist", "scripts", "validate-signal-release.js"), "process.exit(0);\n");
      await writeFile(join(candidate, "dist", "scripts", "pipe-env-value.js"),
        "import{readFileSync}from'node:fs';const a=process.argv.slice(2);if(a.length===2)process.stdout.write('postgres://runtime');else{for await(const c of process.stdin)process.stdout.write('ACE_HUNTER_RUNTIME_DATABASE_URL='+JSON.stringify(String(c))+'\\n')}\n");
      await writeFile(join(candidate, "scripts", "run-user-command.sh"),
        '#!/bin/bash\nscript_dir="$(cd "$(dirname "$0")" && pwd -P)"\nexec "${NODE_PATH}" "${script_dir}/../dist/src/cli/index.js" "$@"\n',
        { mode: 0o755 });
      const fakeGit = join(fakeBin, "git");
      await writeFile(fakeGit,
        `#!/bin/bash\ncase "$1" in fetch|cat-file) exit 0;; rev-parse) printf '%s\\n' '${sha}';; *) exit 1;; esac\n`,
        { mode: 0o755 });
      await chmod(fakeGit, 0o755);
      const fakeNode = join(fakeBin, "node");
      await writeFile(fakeNode, `#!/bin/bash
if [[ "\${1:-}" = --version ]]; then printf 'v22.17.0\\n'; exit 0; fi
exec ${JSON.stringify(process.execPath)} "$@"
`, { mode: 0o755 });
      const fakeLaunchctl = join(fakeBin, "launchctl");
      await writeFile(fakeLaunchctl, `#!/bin/bash
case "$1" in
  print) exit 113;;
  print-disabled) printf 'disabled services = {\\n}\\n';;
  *) exit 0;;
esac
`, { mode: 0o755 });
      await chmod(fakeLaunchctl, 0o755);
      await execFile("node", ["scripts/release-integrity.mjs", "seal", candidate, sha], { cwd: process.cwd() });
      await execFile("node", ["scripts/release-transaction.mjs", "begin", transaction, app, codexHome], {
        cwd: process.cwd(), env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}` },
      });

      await expect(execFile("bash", ["ops/launchd/deploy-main.sh", sha, liveEnv, transaction], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, CODEX_HOME: codexHome, PATH: `${fakeBin}:${process.env.PATH}` },
      })).rejects.toMatchObject({ code: 23 });

      expect(await readlink(join(app, "current"))).toBe(prior);
      expect(await readFile(wrapper, "utf8")).toBe(priorWrapper);
      expect(await readlink(skillLink)).toBe(join(prior, "skills", "ace-hunter"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
