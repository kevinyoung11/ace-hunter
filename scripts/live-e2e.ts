import { spawn } from "node:child_process";
import { Pool } from "pg";
import { loadRuntimeConfig } from "../src/config/load-config.js";

const target = repositoryName(process.env.ACE_E2E_REPOSITORY ?? "openai/openai-node");
const maxNew = integerArgument("--max-new", 3, 1, 1_000);
const pool = new Pool({ connectionString: loadRuntimeConfig(process.env).runtimeDatabaseUrl, max: 1 });
const product = await pool.query<{ id: string }>(`select p.id from ace_hunter.products p
  join ace_hunter.product_repositories pr on pr.product_id=p.id and pr.is_primary
  join ace_hunter.repositories r on r.id=pr.repository_id
  where lower(r.full_name)=lower($1) order by p.id limit 1`, [target]);
const latestReport = await pool.query<{ period_end: Date | null }>(`select max(period_end) period_end
  from ace_hunter.analysis_outputs where output_type='daily_report'`);
await pool.end();
const productId = product.rows[0]?.id;
if (!productId) throw new Error("ACE_E2E_REPOSITORY_product_missing");

await run(["job", "discover_github_candidates", "--max-new", String(maxNew)]);
for (const period of ["daily", "weekly", "monthly"]) {
  await run(["job", "collect_github_trending", "--period", period]);
}
await run(["job", "refresh_repo_metrics"]);
await run(["job", "collect_x_posts", "--product-id", productId]);
await run(["job", "analyze_x_posts", "--product-id", productId]);
await run(["job", "collect_x_comments", "--product-id", productId]);

// A live acceptance run can happen after the canonical 00:00 UTC cutoff. The
// next cutoff keeps every just-captured fact in the immutable replay cohort.
let nextCutoff = nextUtcMidnight(new Date());
const priorCutoff = latestReport.rows[0]?.period_end;
if (priorCutoff && priorCutoff.getTime() >= nextCutoff.getTime()) {
  nextCutoff = new Date(priorCutoff.getTime() + 86_400_000);
}
await run(["job", "generate_report", "--scheduled-for", nextCutoff.toISOString(), "--cutoff-hour-utc", "0"]);
await run(["job", "evaluate_success"]);
await run(["job", "retention"]);

await run(["today", "--format", "json"]);
await run(["analyze", target, "--format", "json"]);
await run(["observe", target, "--format", "json"]);
await run(["follow", target]);
await run(["list"]);
await run(["unfollow", target]);

process.stdout.write(`${JSON.stringify({ repository: target, jobs: 11, commands: 6 })}\n`);

async function run(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/src/cli/index.js", ...args], {
      stdio: "ignore",
      env: process.env,
      shell: false,
    });
    child.once("error", () => reject(new Error("ace_hunter_process_unavailable")));
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`ace_hunter_failed:${args[0]}:${args[1] ?? ""}`));
    });
  });
}

function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
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
