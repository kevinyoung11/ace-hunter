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

describe("post-switch minimal signal smokes", () => {
  it("uses the deployment-managed wrapper for every JSON read route", async () => {
    const script = await readFile("ops/launchd/deploy-main.sh", "utf8");
    const commands = [
      "potential --format json",
      "trending daily --format json",
      "trending weekly --format json",
      "trending monthly --format json",
      "trending all --format json",
    ];

    for (const command of commands) {
      expect(script).toContain(`ACE_HUNTER_ENV_FILE="$live_env" "$wrapper" ${command} >/dev/null`);
    }
  });

  it("keeps every new smoke inside the transaction that restores all switched artifacts", async () => {
    const script = await readFile("ops/launchd/deploy-main.sh", "utf8");
    const switchFinished = script.indexOf('atomic_replace "${skill_link}.new.$$" "$skill_link"');
    const firstSignalSmoke = script.indexOf('ACE_HUNTER_ENV_FILE="$live_env" "$wrapper" potential --format json >/dev/null');
    const transactionCommitted = script.indexOf("trap - ERR HUP INT TERM", firstSignalSmoke);

    expect(switchFinished).toBeGreaterThan(-1);
    expect(firstSignalSmoke).toBeGreaterThan(switchFinished);
    expect(transactionCommitted).toBeGreaterThan(firstSignalSmoke);
    expect(script.indexOf("trap 'rollback_exit $?' ERR")).toBeLessThan(firstSignalSmoke);
    expect(script).toContain('rm -f "$current" "$wrapper" "$skill_link"');
    expect(script).toContain('atomic_replace "${current}.rollback.$$" "$current"');
    expect(script).toContain('atomic_replace "${wrapper}.rollback.$$" "$wrapper"');
    expect(script).toContain('atomic_replace "${skill_link}.rollback.$$" "$skill_link"');
    expect(script).not.toMatch(/set\s+-[^\n]*x/u);
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
      ]);
      await writeFile(liveEnv, "ACE_HUNTER_RUNTIME_DATABASE_URL=postgres://runtime\n", { mode: 0o600 });
      await writeFile(wrapper, priorWrapper, { mode: 0o755 });
      await symlink(prior, join(app, "current"));
      await symlink(join(prior, "skills", "ace-hunter"), skillLink);
      await writeFile(join(candidate, "dist", "src", "cli", "index.js"),
        "if(process.argv[2]==='trending'&&process.argv[3]==='weekly')process.exit(23);\n");
      await writeFile(join(candidate, "scripts", "validate-skill.mjs"), "process.exit(0);\n");
      await writeFile(join(candidate, "scripts", "run-user-command.sh"),
        '#!/bin/bash\nscript_dir="$(cd "$(dirname "$0")" && pwd -P)"\nexec "${NODE_PATH}" "${script_dir}/../dist/src/cli/index.js" "$@"\n',
        { mode: 0o755 });
      const fakeGit = join(fakeBin, "git");
      await writeFile(fakeGit,
        `#!/bin/bash\ncase "$1" in fetch|cat-file) exit 0;; rev-parse) printf '%s\\n' '${sha}';; *) exit 1;; esac\n`,
        { mode: 0o755 });
      await chmod(fakeGit, 0o755);

      await expect(execFile("bash", ["ops/launchd/deploy-main.sh", sha, liveEnv], {
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
