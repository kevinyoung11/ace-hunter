import { spawn } from "node:child_process";
import { Pool } from "pg";
import { loadRuntimeConfig } from "../src/config/load-config.js";
import { GitHubHttpClientFactory } from "../src/sources/github/github-http-client.js";
import { createHttpTransport } from "../src/core/http-transport.js";

const config = loadRuntimeConfig(process.env);
const target = repositoryName(process.env.ACE_E2E_REPOSITORY ?? "openai/openai-node");
const maxNew = integerArgument("--max-new", 3, 1, 1_000);
const startedAt = new Date();
const http = createHttpTransport(process.env);
const github = await new GitHubHttpClientFactory({ token: config.githubToken, fetcher: http.fetcher }).openOperation();
const pool = new Pool({ connectionString: config.runtimeDatabaseUrl, max: 1 });

try {
  const rate = await github.getRateLimit();
  if (rate.remaining < 1 || !Number.isFinite(rate.resetAt.getTime())) throw new Error("github_rate_invalid");
  const repository = await github.getRepository(target);
  if (repository.fullName.toLowerCase() !== target.toLowerCase()) throw new Error("github_repository_identity_mismatch");

  // An explicit canonical URL is the product-creation contract; owner/name is
  // intentionally lookup-only so typos cannot create products.
  await runAceHunter(["analyze", `https://github.com/${target}`, "--format", "json"]);
  await runAceHunter(["job", "discover_github_candidates", "--max-new", String(maxNew)]);
  for (const period of ["daily", "weekly", "monthly"] as const) {
    await runAceHunter(["job", "collect_github_trending", "--period", period]);
  }

  const trending = await pool.query<{ period: string; count: string }>(`select t.period,count(*)::text count
      from ace_hunter.github_trending_snapshots t
      join ace_hunter.job_runs j on j.id=t.job_run_id
      where j.started_at >= $1 and j.status in ('success','partial')
      group by t.period`, [startedAt]);
  const counts = new Map(trending.rows.map((row) => [row.period, Number(row.count)]));
  for (const period of ["daily", "weekly", "monthly"] as const) {
    if (!Number.isSafeInteger(counts.get(period)) || (counts.get(period) ?? 0) < 1) {
      throw new Error(`github_trending_${period}_empty`);
    }
  }

  let matched = false;
  let storedStars = -1;
  let storedForks = -1;
  for (let attempt = 0; attempt < 3 && !matched; attempt += 1) {
    await runAceHunter(["job", "refresh_repo_metrics"]);
    const stored = await pool.query<{ stars: string; forks: string | null }>(`select s.stars::text,s.forks::text
        from ace_hunter.repositories r
        join ace_hunter.repository_snapshots s on s.repository_id=r.id
        where lower(r.full_name)=lower($1)
        order by s.captured_at desc,s.id desc limit 1`, [target]);
    if (!stored.rows[0] || stored.rows[0].forks === null) throw new Error("github_snapshot_missing");
    storedStars = Number(stored.rows[0].stars);
    storedForks = Number(stored.rows[0].forks);
    const direct = await github.getCoreMetrics(target, new Date());
    matched = direct.stars === storedStars && direct.forks === storedForks;
  }
  if (!matched) throw new Error("github_direct_comparison_changed");

  process.stdout.write(`${JSON.stringify({
    repository: repository.fullName,
    rateRemaining: rate.remaining,
    trending: Object.fromEntries(counts),
    storedStars,
    storedForks,
  })}\n`);
} finally {
  await Promise.allSettled([github.close(), pool.end(), http.close()]);
}

async function runAceHunter(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/src/cli/index.js", ...args], {
      env: process.env,
      shell: false,
      stdio: "ignore",
    });
    child.once("error", () => reject(new Error("ace_hunter_process_unavailable")));
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`ace_hunter_failed:${args[0]}:${args[1] ?? ""}`));
    });
  });
}

function repositoryName(value: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error("ACE_E2E_REPOSITORY_invalid");
  return value;
}

function integerArgument(name: string, fallback: number, minimum: number, maximum: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const raw = process.argv[index + 1] ?? "";
  if (!/^\d+$/.test(raw)) throw new Error(`${name}_invalid`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name}_invalid`);
  return value;
}
