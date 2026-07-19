# Ace Hunter V0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and ship a Skill-first TypeScript CLI that discovers promising GitHub repositories, collects GitHub Trending and X discussion facts into Supabase, ranks Product-level Top 10 candidates, generates daily reports, and performs fresh-on-request product observation.

**Architecture:** Use one modular Node.js process with a stable Commander CLI. Feature modules depend on explicit source and store interfaces; PostgreSQL is the durable source of truth, while GitHub Actions, a local launchd X scheduler, and the Codex Skill invoke the same application services. Deterministic code performs eligibility and ranking, and a versioned model adapter only classifies X content and writes evidence-bound narrative.

**Tech Stack:** Node.js 22, TypeScript, npm, Vitest, ESLint, `pg`, Zod, Commander, Cheerio, native `fetch`, local PostgreSQL 14, Supabase PostgreSQL, GitHub REST/GraphQL APIs, GitHub Actions.

---

## Delivery boundaries

- V0.1 is a trusted, single-user CLI and Skill. `ACE_HUNTER_USER_ID` supplies the existing `auth.users.id`; no Web UI, HTTP API, login flow, notifications, or multi-tenant authorization is added.
- PostgreSQL runtime access uses only `ACE_HUNTER_RUNTIME_DATABASE_URL`; catalog preflight and migration use only `ACE_HUNTER_MIGRATION_DATABASE_URL`. Supabase Data API is not exposed. Every migration and query explicitly qualifies `ace_hunter.*`.
- Keep the approved nine-table model. Add `x_last_attempted_at`, `x_last_success_at`, `x_collection_status`, and `x_last_error_code` to `products`, plus `idempotency_key` and nullable `next_attempt_at` to `job_runs`. These fields distinguish X success-with-zero-results from failure, prevent duplicate scheduled execution, and make retry deadlines durable across process restarts without adding a tenth table.
- X collection is implemented through `XSourceAdapter`; the production adapter invokes authenticated `twitter-cli` 0.8.5 (`status`, `search`, `tweet`, and `article`) at `TWITTER_CLI_PATH`. Model analysis is implemented through `ContentAnalyzer`; production acceptance requires `ACE_HUNTER_DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, and `DEEPSEEK_MODEL`.
- Do not implement Downloads, Web UI, proactive alerts, automatic Product merge, automatic Repo eviction, Product Hunt, Reddit, or support for more than 1,000 tracked repositories.
- A test fixture proves parsing and edge behavior, but a fixture never counts as live end-to-end acceptance.

## Module and file map

```text
src/
  cli/{index.ts,output.ts,commands/*.ts}
  config/{schema.ts,load-config.ts}
  core/{clock.ts,errors.ts,logger.ts,result.ts,time-buckets.ts}
  core/domain/{product.ts,repository.ts,snapshot.ts,x-post.ts,analysis-output.ts}
  db/{client.ts,migrate.ts,transaction.ts,migrations/0001_ace_hunter_initial.sql}
  db/stores/{product-store.ts,repository-store.ts,snapshot-store.ts,trending-store.ts,x-post-store.ts,monitor-store.ts,analysis-output-store.ts,job-run-store.ts}
  sources/github/{github-source.ts,github-http-client.ts,repository-search.ts,metrics-reader.ts,request-budget.ts,schemas.ts}
  sources/trending/{trending-source.ts,github-trending-source.ts,parse-trending.ts}
  sources/x/{x-source.ts,twitter-cli-source.ts,query-builder.ts,schemas.ts}
  analysis/{content-analyzer.ts,model-content-analyzer.ts,deduplicate-posts.ts,percentiles.ts,scoring.ts,representative-posts.ts}
  jobs/{job-runner.ts,retry-policy.ts,discover-github-candidates.ts,collect-github-trending.ts,refresh-repo-metrics.ts,collect-x-posts.ts,analyze-x-posts.ts,collect-x-comments.ts,generate-report.ts,retention.ts}
  products/{resolve-product.ts,create-product-from-repo.ts,analyze-product.ts,observe-product.ts,monitor-product.ts}
  reports/{report-data.ts,daily-report.ts,product-report.ts,markdown-renderer.ts}
skills/ace-hunter/SKILL.md
tests/{unit,integration,contract,e2e}/
scripts/{supabase-safety-check.ts,live-github-smoke.ts,live-x-smoke.ts,live-e2e.ts}
.github/workflows/{ci.yml,discover.yml,trending.yml,refresh-metrics.yml,collect-x.yml,daily-report.yml}
```

Dependency direction is `cli/jobs -> products/reports/analysis -> sources + stores -> db/core`. Source adapters never write the database; jobs coordinate adapters and stores. Store classes never call external APIs. `analysis/scoring.ts` remains pure and cannot import a model SDK.

## Acceptance matrix

| Boundary | Automated acceptance | Live acceptance |
|---|---|---|
| Configuration and secret safety | malformed environment fails; logger redacts credentials | CLI starts from external `.env.local` without printing values |
| Database | migrations and constraints pass on local PostgreSQL 14 | only `ace_hunter` changes in shared Supabase |
| GitHub discovery | time/star slicing, exclusions, idempotency | a public qualifying Repo creates exactly one Product and Primary Repo |
| Trending | three fixture periods and structural-failure behavior | daily, weekly, monthly pages persist ranked snapshots |
| Metrics | exact metric semantics, bucket idempotency, partial budget | public Repo facts match GitHub API |
| X | query, dedupe, limits, status semantics, model schema | real post and eligible comments persist with working URLs |
| Ranking | golden calculations and leakage tests | one stored Top 10 score is independently recomputed |
| Reports | evidence rules, Top 10, replay stability | a real `daily_report` row is rendered and readable |
| Skill/use cases | all five intents and deadline behavior | today/analyze/observe/follow/list/unfollow run against Supabase |
| Operations | schedules, retention, CI, log redaction | every workflow completes via `workflow_dispatch` |
| Release | full regression | PR checks green, PR merged, remote `main` verified |

## Parallel worktree strategy

Use one branch and worktree per task: `feature/ace-hunter-task-N`. Never let two agents edit the same file. Merge only after the task's RED/GREEN checks and review pass.

```text
Stage A: Task 1
Stage B: Task 2
Stage C: Task 3
Stage D in parallel: Task 4 and Task 7
Stage E after Task 4: Task 5 and Task 6 in parallel
Stage F: Task 8
Stage G in parallel: Task 9 and the resolver/monitor portion of Task 10
Stage H: finish Task 10 integration
Stage I: Task 11
Stage J: Task 12
```

The integration owner cherry-picks reviewed task commits in numeric dependency order. After each cherry-pick run `npm test && npm run typecheck && npm run lint`. Database migrations, shared interfaces, and final integration are serial gates even when feature implementation is parallel.

### Task 1: Project foundation, configuration, and secret-safe CLI

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `eslint.config.js`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/config/schema.ts`
- Create: `src/config/load-config.ts`
- Create: `src/core/logger.ts`
- Create: `src/cli/index.ts`
- Test: `tests/unit/config/load-config.test.ts`
- Test: `tests/unit/core/logger.test.ts`

- [ ] **Step 1: Write failing configuration and redaction tests**

```ts
// tests/unit/config/load-config.test.ts
import { describe, expect, it } from "vitest";
import { loadMigrationConfig, loadRuntimeConfig } from "../../../src/config/load-config.js";

const valid = {
  ACE_HUNTER_MIGRATION_DATABASE_URL: "postgres://admin:secret@localhost:5432/ace_test",
  ACE_HUNTER_MIGRATION_SHA256: "a".repeat(64),
  ACE_HUNTER_RUNTIME_DATABASE_URL: "postgres://ace:secret@localhost:5432/ace_test",
  ACE_HUNTER_GITHUB_TOKEN: "github-secret",
  ACE_HUNTER_USER_ID: "5d991d19-d5e2-45e8-a8f9-724957aa2137",
};

describe("loadConfig", () => {
  it("parses the required server configuration", () => {
    expect(loadRuntimeConfig(valid)).toMatchObject({ githubToken: "github-secret", runtimeDatabaseUrl: valid.ACE_HUNTER_RUNTIME_DATABASE_URL });
    expect(loadMigrationConfig({ ACE_HUNTER_MIGRATION_DATABASE_URL: valid.ACE_HUNTER_MIGRATION_DATABASE_URL, ACE_HUNTER_MIGRATION_SHA256: valid.ACE_HUNTER_MIGRATION_SHA256 })).toEqual({ migrationDatabaseUrl: valid.ACE_HUNTER_MIGRATION_DATABASE_URL, migrationSha256: valid.ACE_HUNTER_MIGRATION_SHA256 });
  });

  it("reports a missing key without echoing any secret", () => {
    expect(() => loadRuntimeConfig({ ...valid, ACE_HUNTER_RUNTIME_DATABASE_URL: undefined })).toThrow(/ACE_HUNTER_RUNTIME_DATABASE_URL/);
    expect(() => loadRuntimeConfig({ ...valid, ACE_HUNTER_RUNTIME_DATABASE_URL: undefined })).not.toThrow(/github-secret/);
    expect(() => loadMigrationConfig(valid)).not.toThrow();
  });
});
```

```ts
// tests/unit/core/logger.test.ts
import { expect, it } from "vitest";
import { redact } from "../../../src/core/logger.js";

it("redacts URL passwords and authorization values", () => {
  expect(redact("postgres://ace:secret@db/x Authorization: Bearer token Cookie: auth=cookie Set-Cookie: sid=value https://x.test?q=ok&api_key=query-secret dynamic-secret", ["dynamic-secret"]))
    .toBe("postgres://ace:[REDACTED]@db/x Authorization: [REDACTED] Cookie: [REDACTED] Set-Cookie: [REDACTED] https://x.test?q=ok&api_key=[REDACTED] [REDACTED]");
});
```

- [ ] **Step 2: Run RED tests**

Run: `npm test -- --run tests/unit/config/load-config.test.ts tests/unit/core/logger.test.ts`

Expected: FAIL with module-not-found errors for `src/config/load-config.ts` and `src/core/logger.ts`.

- [ ] **Step 3: Add the exact project scripts and configuration implementation**

```json
{
  "name": "ace-hunter",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22 <23" },
  "bin": { "ace-hunter": "dist/src/cli/index.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint .",
    "start": "node dist/src/cli/index.js",
    "dev": "node --import tsx src/cli/index.ts",
    "db:migrate": "node --import tsx src/db/migrate.ts"
  },
  "dependencies": {
    "cheerio": "^1.1.0",
    "commander": "^14.0.0",
    "dotenv": "^17.0.0",
    "pg": "^8.16.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@eslint/js": "^9.0.0",
    "@types/node": "^22.0.0",
    "@types/pg": "^8.15.0",
    "eslint": "^9.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.8.0",
    "typescript-eslint": "^8.0.0",
    "vitest": "^3.0.0"
  }
}
```

Create `.gitignore` with `node_modules/`, `dist/`, `coverage/`, `.env*`, `.e2e/`, and the explicit negation `!.env.example`. No credential, database fingerprint, X session artifact, or live E2E output may be staged.

```ts
// src/config/schema.ts
import { z } from "zod";

export const adminEnvSchema = z.object({ ACE_HUNTER_ADMIN_DATABASE_URL: z.string().url() });
export const migrationEnvSchema = z.object({ ACE_HUNTER_MIGRATION_DATABASE_URL: z.string().url(), ACE_HUNTER_MIGRATION_SHA256: z.string().regex(/^[a-f0-9]{64}$/) });
export const runtimeEnvSchema = z.object({
  ACE_HUNTER_RUNTIME_DATABASE_URL: z.string().url(),
  ACE_HUNTER_GITHUB_TOKEN: z.string().min(1),
  ACE_HUNTER_USER_ID: z.string().uuid(),
  TWITTER_CLI_PATH: z.string().min(1).default("twitter"),
  ACE_HUNTER_DEEPSEEK_API_KEY: z.string().min(1).optional(),
  DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL: z.string().min(1).default("deepseek-chat"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type AppConfig = ReturnType<typeof loadConfigShape>;
export function loadConfigShape(env: z.infer<typeof runtimeEnvSchema>) {
  return {
    runtimeDatabaseUrl: env.ACE_HUNTER_RUNTIME_DATABASE_URL,
    githubToken: env.ACE_HUNTER_GITHUB_TOKEN,
    userId: env.ACE_HUNTER_USER_ID,
    twitterCliPath: env.TWITTER_CLI_PATH,
    deepseekApiKey: env.ACE_HUNTER_DEEPSEEK_API_KEY,
    deepseekBaseUrl: env.DEEPSEEK_BASE_URL,
    deepseekModel: env.DEEPSEEK_MODEL,
    logLevel: env.LOG_LEVEL,
  };
}
export function loadedSecretValues(config: AppConfig): string[] {
  return [config.runtimeDatabaseUrl,config.githubToken,config.deepseekApiKey].filter((value): value is string => Boolean(value));
}
```

```ts
// src/config/load-config.ts
import { readFileSync } from "node:fs";
import { parse } from "dotenv";
import { adminEnvSchema, migrationEnvSchema, runtimeEnvSchema, loadConfigShape } from "./schema.js";

function mergedEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  const fileEnv = env.ACE_HUNTER_ENV_FILE ? parse(readFileSync(env.ACE_HUNTER_ENV_FILE, "utf8")) : {};
  return { ...fileEnv, ...env };
}
export function loadMigrationConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  const parsed = migrationEnvSchema.safeParse(mergedEnv(env));
  if (!parsed.success) throw new Error(`Invalid configuration keys: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  return { migrationDatabaseUrl: parsed.data.ACE_HUNTER_MIGRATION_DATABASE_URL, migrationSha256: parsed.data.ACE_HUNTER_MIGRATION_SHA256 };
}
export function loadAdminConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  const parsed = adminEnvSchema.safeParse(mergedEnv(env));
  if (!parsed.success) throw new Error("Invalid configuration keys: ACE_HUNTER_ADMIN_DATABASE_URL");
  return { adminDatabaseUrl: parsed.data.ACE_HUNTER_ADMIN_DATABASE_URL };
}
export function loadRuntimeConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  const parsed = runtimeEnvSchema.safeParse(mergedEnv(env));
  if (!parsed.success) {
    const keys = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid configuration keys: ${keys}`);
  }
  return loadConfigShape(parsed.data);
}
export function loadRedactionRegistry(env: NodeJS.ProcessEnv): string[] {
  let values: Record<string,string|undefined>={...env};
  try { values=mergedEnv(env); } catch { /* Top-level error handling must never throw while building redaction state. */ }
  return [values.ACE_HUNTER_ADMIN_DATABASE_URL,values.ACE_HUNTER_MIGRATION_DATABASE_URL,values.ACE_HUNTER_RUNTIME_DATABASE_URL,values.ACE_HUNTER_GITHUB_TOKEN,values.ACE_HUNTER_DEEPSEEK_API_KEY].filter((value): value is string=>Boolean(value));
}
```

```ts
// src/core/logger.ts
export function redact(message: string, loadedSecrets: readonly string[] = []): string {
  const structural = message
    .replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/gi, "$1[REDACTED]@")
    .replace(/(Authorization:\s*)(?:Bearer\s+)?\S+/gi, "$1[REDACTED]")
    .replace(/((?:Set-)?Cookie:\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|key)=)[^&\s]+/gi, "$1[REDACTED]");
  return loadedSecrets.filter(Boolean).sort((a,b) => b.length-a.length).reduce((text, secret) => text.split(secret).join("[REDACTED]"), structural);
}

export function log(level: "info" | "warn" | "error", message: string, loadedSecrets: readonly string[] = []): void {
  process.stderr.write(`${JSON.stringify({ level, message: redact(message,loadedSecrets) })}\n`);
}
```

```ts
// src/cli/index.ts
#!/usr/bin/env node
import { Command } from "commander";
import { log } from "../core/logger.js";
import { loadRedactionRegistry } from "../config/load-config.js";

const program = new Command()
  .name("ace-hunter")
  .description("Discover and observe promising open-source products")
  .version("0.1.0");

program.parseAsync(process.argv).catch((error: unknown) => {
  log("error", error instanceof Error ? error.message : String(error), loadRedactionRegistry(process.env));
  process.exitCode = 1;
});
```

Create `tsconfig.json` with `module` and `moduleResolution` set to `NodeNext`, strict mode enabled, `rootDir` as `.`, and output to `dist`; configure Vitest for Node and ESLint with the TypeScript recommended rules. `.env.example` contains the union of `migrationEnvSchema` and `runtimeEnvSchema` keys, each empty except documented Twitter CLI and DeepSeek defaults. Runtime commands call only `loadRuntimeConfig`; `db:migrate` calls only `loadMigrationConfig`, so the privileged URL is never required or retained by normal jobs.

- [ ] **Step 4: Install and run GREEN checks**

Run: `npm install && npm test -- --run tests/unit/config/load-config.test.ts tests/unit/core/logger.test.ts && npm run typecheck && npm run lint && npm run build && node dist/src/cli/index.js --help`

Expected: both tests PASS; typecheck, lint, and build exit 0; help contains `Discover and observe promising open-source products`.

- [ ] **Step 5: Commit Task 1**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts eslint.config.js .gitignore .env.example src/config src/core/logger.ts src/cli/index.ts tests/unit/config tests/unit/core
git commit -m "chore: initialize ace hunter typescript cli"
```

### Task 2: PostgreSQL schema, migrations, and typed stores

**Files:**
- Create: `src/db/client.ts`
- Create: `src/db/migrate.ts`
- Create: `src/db/schema-manifest.ts`
- Create: `src/db/migrations/0001_ace_hunter_initial.sql`
- Create: `ops/01_bootstrap_roles.sql`
- Create: `ops/02_activate_runtime_role.sql`
- Create: `src/db/stores/product-store.ts`
- Create: `src/db/stores/repository-store.ts`
- Create: `src/db/stores/snapshot-store.ts`
- Create: `src/db/stores/trending-store.ts`
- Create: `src/db/stores/x-post-store.ts`
- Create: `src/db/stores/monitor-store.ts`
- Create: `src/db/stores/analysis-output-store.ts`
- Create: `src/db/stores/job-run-store.ts`
- Test: `tests/integration/db/migrations.test.ts`
- Test: `tests/integration/db/stores.test.ts`
- Test support: `tests/helpers/bootstrap-test-db.sql`

- [ ] **Step 1: Start an isolated local PostgreSQL 14 database**

Run:

```bash
createdb ace_hunter_test 2>/dev/null || psql postgres -Atqc "select 1 from pg_database where datname='ace_hunter_test'" | grep -qx 1
export ACE_TEST_ADMIN_DATABASE_URL=postgres://localhost/ace_hunter_test
export ACE_TEST_MIGRATION_DATABASE_URL=postgres://ace_hunter_migrator:test-migrator@localhost/ace_hunter_test
export ACE_TEST_RUNTIME_DATABASE_URL=postgres://ace_hunter_runtime:test-runtime@localhost/ace_hunter_test
psql "$ACE_TEST_ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/helpers/bootstrap-test-db.sql
export ACE_TEST_DATABASE_URL="$ACE_TEST_RUNTIME_DATABASE_URL"
```

Expected: all commands exit 0. This database name is the only local database that later test cleanup may drop.

Write `tests/helpers/bootstrap-test-db.sql` before this command. It uses `DO` blocks guarded by `pg_roles`, then `ALTER ROLE` to reassert exact `NO*` capabilities and local test passwords; creates `auth`, `extensions`, `auth.users`, and the owner-owned `ace_hunter` schema only when absent; reasserts only owner→migrator membership, `auth` schema `USAGE`, and `auth.users(id)` `REFERENCES`; and revokes every unintended Public/Ace role grant. Running it twice is an acceptance assertion and must succeed. CI invokes this exact file rather than duplicating bootstrap DDL.

- [ ] **Step 2: Write the failing migration constraint test**

```ts
// tests/integration/db/migrations.test.ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { migrate } from "../../../src/db/migrate.js";

const adminPool = new Pool({ connectionString: process.env.ACE_TEST_ADMIN_DATABASE_URL });
const migratorPool = new Pool({ connectionString: process.env.ACE_TEST_MIGRATION_DATABASE_URL });
const runtimePool = new Pool({ connectionString: process.env.ACE_TEST_RUNTIME_DATABASE_URL });
const migrationSql = readFileSync("src/db/migrations/0001_ace_hunter_initial.sql", "utf8");
const migrationChecksum = createHash("sha256").update(migrationSql).digest("hex");
async function emptyOwnerSchema() {
  await adminPool.query("drop schema if exists ace_hunter cascade; create schema ace_hunter authorization ace_hunter_owner");
}
async function restoreValidSchema() {
  await emptyOwnerSchema();
  await migrate(migratorPool, { expectedChecksum: migrationChecksum });
}
beforeAll(async () => {
  await restoreValidSchema();
});
afterAll(async () => { await Promise.all([adminPool.end(),migratorPool.end(),runtimePool.end()]); });

it("creates exactly the nine approved business tables", async () => {
  const result = await runtimePool.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema='ace_hunter' order by 1",
  );
  expect(result.rows.map((row) => row.table_name)).toEqual([
    "analysis_outputs", "github_trending_snapshots", "job_runs", "product_repositories",
    "product_x_posts", "products", "repositories", "repository_snapshots", "user_product_monitors",
  ]);
});

it("enforces one primary repository per product", async () => {
  await runtimePool.query("insert into ace_hunter.products(id,name,status) values('00000000-0000-4000-8000-000000000001','p','active')");
  for (const suffix of ["2", "3"]) {
    await runtimePool.query(`insert into ace_hunter.repositories(id,github_repo_id,name,full_name,repo_url,status,github_created_at) values('00000000-0000-4000-8000-00000000000${suffix}',${suffix},'r${suffix}','o/r${suffix}','https://github.com/o/r${suffix}','active',now())`);
  }
  await runtimePool.query("insert into ace_hunter.product_repositories(product_id,repository_id,role,is_primary,link_source) values('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','primary',true,'discovery')");
  await expect(runtimePool.query("insert into ace_hunter.product_repositories(product_id,repository_id,role,is_primary,link_source) values('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','primary',true,'discovery')")).rejects.toMatchObject({ code: "23505" });
});

describe("destructive migration guards", () => {
  beforeEach(emptyOwnerSchema);
  afterEach(restoreValidSchema);

  it("rejects a residual or manually altered ace_hunter schema before DDL", async () => {
    await adminPool.query("create table ace_hunter.products(id uuid primary key)");
    await expect(migrate(migratorPool, { expectedChecksum: migrationChecksum })).rejects.toThrow(/catalog preflight/);
    const catalog = await adminPool.query("select table_name from information_schema.tables where table_schema='ace_hunter'");
    expect(catalog.rows).toEqual([{ table_name: "products" }]);
  });

  it("rolls back every DDL statement when a migration statement fails", async () => {
    const faultySql = "begin; create table ace_hunter.partial(id int); select missing_function(); commit;";
    const checksum = createHash("sha256").update(faultySql).digest("hex");
    await expect(migrate(migratorPool, { expectedChecksum: checksum, sqlOverride: faultySql })).rejects.toThrow(/missing_function/);
    expect((await adminPool.query("select count(*)::int n from information_schema.tables where table_schema='ace_hunter'")).rows[0].n).toBe(0);
  });

  it("rejects a wrong migration checksum before catalog or DDL changes", async () => {
    await expect(migrate(migratorPool, { expectedChecksum: "0".repeat(64) })).rejects.toThrow(/checksum mismatch/);
    expect((await adminPool.query("select count(*)::int n from information_schema.tables where table_schema='ace_hunter'")).rows[0].n).toBe(0);
  });
});

it("forces RLS and denies public access on all nine tables", async () => {
  const rows = await adminPool.query(`select c.relname,c.relrowsecurity,c.relforcerowsecurity,has_table_privilege('public',c.oid,'select') as public_select from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='ace_hunter' and c.relkind='r' order by 1`);
  expect(rows.rows).toHaveLength(9);
  expect(rows.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity && !r.public_select)).toBe(true);
});

it("rejects every invalid enum, status, count, probability, and time ordering", async () => {
  // Valid-row factories first insert required parents, then override exactly one field.
  const invalidMutations = [
    productRow({status:'unknown'}), repositoryRow({status:'unknown'}), repositoryRow({owner_type:'Bot'}),
    trendingRow({collection_status:'unknown'}), xPostRow({post_type:'unknown'}),
    xPostRow({sentiment:'unknown'}), xPostRow({stance:'unknown'}), monitorRow({status:'unknown'}),
    analysisRow({status:'unknown'}), analysisRow({trigger_type:'unknown'}),
    analysisRow({period_end:'2026-07-18T00:00:00Z',period_start:'2026-07-19T00:00:00Z'}),
    jobRunRow({status:'unknown'}), jobRunRow({trigger_type:'unknown'}), jobRunRow({attempt:3}),
    snapshotRow({stars:-1}), xPostRow({relevance_score:1.1}), productRepositoryRow({confidence:1.1}),
  ];
  for (const mutation of invalidMutations) await expect(mutation(runtimePool)).rejects.toMatchObject({ code:'23514' });
  expect(await enumerateCheckConstraints(adminPool)).toEqual(expectedCheckConstraintNames);
});
```

Place the three destructive cases in their own `describe`. Its `beforeEach` uses the admin DSN to drop and recreate an empty owner schema; its `afterEach` always drops/recreates the schema and reruns the valid migration through a separate migrator Pool, even when the assertion fails. All non-destructive tests use a runtime Pool and never share mutated catalog state. A final `afterAll` queries the administrator catalog and asserts the complete manifest, preventing test order from leaving a residual schema.

- [ ] **Step 3: Run the migration test RED**

Run: `ACE_TEST_ADMIN_DATABASE_URL=$ACE_TEST_ADMIN_DATABASE_URL ACE_TEST_MIGRATION_DATABASE_URL=$ACE_TEST_MIGRATION_DATABASE_URL ACE_TEST_RUNTIME_DATABASE_URL=$ACE_TEST_RUNTIME_DATABASE_URL npm test -- --run tests/integration/db/migrations.test.ts`

Expected: FAIL because `src/db/migrate.ts` does not exist.

- [ ] **Step 4: Create the migration and runner**

The SQL file must begin and end as follows and contain every column, foreign key, check, unique constraint, and index in the approved specification:

```sql
begin;
set local role ace_hunter_owner;
create schema if not exists ace_hunter;
create table if not exists ace_hunter.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  website_url text,
  identifiers jsonb not null default '{}'::jsonb,
  status text not null,
  first_seen_at timestamptz not null default now(),
  x_last_attempted_at timestamptz,
  x_last_success_at timestamptz,
  x_collection_status text not null default 'not_collected' check (x_collection_status in ('not_collected','success_with_results','success_empty','unavailable')),
  x_last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Continue the same SQL file with these complete table definitions:

```sql
create table if not exists ace_hunter.repositories (
 id uuid primary key default gen_random_uuid(), github_repo_id bigint not null unique, github_node_id text unique, owner_id bigint, owner_login text not null, owner_type text, owner_profile_url text, owner_avatar_url text, name text not null, full_name text not null, description text, repo_url text not null, homepage_url text, default_branch text, language text, license text, topics jsonb not null default '[]', has_readme boolean not null default false, github_created_at timestamptz not null, github_pushed_at timestamptz, is_fork boolean not null, is_archived boolean not null, is_template boolean not null, is_mirror boolean not null, status text not null, first_seen_at timestamptz not null default now(), last_synced_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists ace_hunter.product_repositories (
 product_id uuid not null references ace_hunter.products(id), repository_id uuid not null references ace_hunter.repositories(id), role text not null, is_primary boolean not null default false, confidence numeric, link_source text not null, created_at timestamptz not null default now(), primary key(product_id,repository_id));
create table if not exists ace_hunter.repository_snapshots (
 id uuid primary key default gen_random_uuid(), repository_id uuid not null references ace_hunter.repositories(id), captured_at timestamptz not null, granularity text not null check(granularity in ('hourly','daily','realtime')), stars bigint not null, forks bigint, commits_30d integer, pr_total integer, pr_open integer, pr_merged integer, releases_count integer, latest_release_at timestamptz, latest_release_tag text, issues_total integer, issues_open integer, issues_closed integer, aux_metrics_captured_at timestamptz, candidate_buckets text[] not null default '{}', candidate_rule_version text, collected_fields jsonb not null default '{}', created_at timestamptz not null default now());
create table if not exists ace_hunter.github_trending_snapshots (
 id uuid primary key default gen_random_uuid(), repository_id uuid not null references ace_hunter.repositories(id), period text not null check(period in ('daily','weekly','monthly')), language text not null default 'all', captured_at timestamptz not null, rank integer not null check(rank > 0), stars_in_period bigint, source_url text not null, collection_status text not null, job_run_id uuid, created_at timestamptz not null default now());
create table if not exists ace_hunter.product_x_posts (
 id uuid primary key default gen_random_uuid(), product_id uuid not null references ace_hunter.products(id), repository_id uuid references ace_hunter.repositories(id), x_post_id text not null, conversation_id text, root_post_id text, in_reply_to_post_id text, post_type text not null, author_id text not null, author_username text not null, author_name text, author_verified boolean, content text not null, language text, post_url text not null, x_created_at timestamptz not null, likes bigint not null default 0, reposts bigint not null default 0, quotes bigint not null default 0, replies bigint not null default 0, bookmarks bigint, views bigint, metrics_updated_at timestamptz, match_method text, matched_identifier text, relation_source text, relevance_score numeric, topic text, sentiment text, stance text, is_duplicate boolean not null default false, duplicate_cluster_id text, automation_probability numeric, is_project_affiliated boolean, analysis_version text, model_name text, analyzed_at timestamptz, first_seen_at timestamptz not null default now(), last_synced_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists ace_hunter.user_product_monitors (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), product_id uuid not null references ace_hunter.products(id), status text not null, started_at timestamptz not null default now(), last_observed_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists ace_hunter.analysis_outputs (
 id uuid primary key default gen_random_uuid(), output_type text not null check(output_type in ('daily_report','product_analysis','realtime_observation')), user_id uuid references auth.users(id), product_id uuid references ace_hunter.products(id), monitor_id uuid references ace_hunter.user_product_monitors(id), period_start timestamptz not null, period_end timestamptz not null, data_cutoff_at timestamptz not null, status text not null, verdict text, confidence numeric, title text not null, summary text, structured_content jsonb not null default '{}', rendered_markdown text not null, analysis_version text not null, model_name text, trigger_type text not null, idempotency_key text, source_job_run_id uuid, started_at timestamptz not null, completed_at timestamptz, created_at timestamptz not null default now());
create table if not exists ace_hunter.job_runs (
 id uuid primary key default gen_random_uuid(), job_name text not null, trigger_type text not null, parent_run_id uuid references ace_hunter.job_runs(id), scheduled_for timestamptz not null, parameters jsonb not null default '{}', status text not null, started_at timestamptz not null, completed_at timestamptz, data_cutoff_at timestamptz, items_expected integer, items_succeeded integer, items_failed integer, items_skipped integer, failed_items jsonb not null default '[]', error_summary text, attempt integer not null default 0, next_attempt_at timestamptz, idempotency_key text not null, created_at timestamptz not null default now());
do $$ begin
  if not exists (select 1 from pg_constraint where conname='github_trending_snapshots_job_run_id_fkey' and conrelid='ace_hunter.github_trending_snapshots'::regclass) then
    alter table ace_hunter.github_trending_snapshots add constraint github_trending_snapshots_job_run_id_fkey foreign key(job_run_id) references ace_hunter.job_runs(id);
  end if;
end $$;
alter table ace_hunter.product_repositories drop constraint product_repositories_product_id_fkey, add constraint product_repositories_product_id_fkey foreign key(product_id) references ace_hunter.products(id) on delete cascade, drop constraint product_repositories_repository_id_fkey, add constraint product_repositories_repository_id_fkey foreign key(repository_id) references ace_hunter.repositories(id) on delete cascade;
alter table ace_hunter.repository_snapshots drop constraint repository_snapshots_repository_id_fkey, add constraint repository_snapshots_repository_id_fkey foreign key(repository_id) references ace_hunter.repositories(id) on delete cascade;
alter table ace_hunter.github_trending_snapshots drop constraint github_trending_snapshots_repository_id_fkey, add constraint github_trending_snapshots_repository_id_fkey foreign key(repository_id) references ace_hunter.repositories(id) on delete restrict, drop constraint github_trending_snapshots_job_run_id_fkey, add constraint github_trending_snapshots_job_run_id_fkey foreign key(job_run_id) references ace_hunter.job_runs(id) on delete set null;
alter table ace_hunter.product_x_posts drop constraint product_x_posts_product_id_fkey, add constraint product_x_posts_product_id_fkey foreign key(product_id) references ace_hunter.products(id) on delete restrict, drop constraint product_x_posts_repository_id_fkey, add constraint product_x_posts_repository_id_fkey foreign key(repository_id) references ace_hunter.repositories(id) on delete restrict;
alter table ace_hunter.user_product_monitors drop constraint user_product_monitors_user_id_fkey, add constraint user_product_monitors_user_id_fkey foreign key(user_id) references auth.users(id) on delete cascade, drop constraint user_product_monitors_product_id_fkey, add constraint user_product_monitors_product_id_fkey foreign key(product_id) references ace_hunter.products(id) on delete restrict;
alter table ace_hunter.analysis_outputs drop constraint analysis_outputs_user_id_fkey, add constraint analysis_outputs_user_id_fkey foreign key(user_id) references auth.users(id) on delete set null, drop constraint analysis_outputs_product_id_fkey, add constraint analysis_outputs_product_id_fkey foreign key(product_id) references ace_hunter.products(id) on delete restrict, drop constraint analysis_outputs_monitor_id_fkey, add constraint analysis_outputs_monitor_id_fkey foreign key(monitor_id) references ace_hunter.user_product_monitors(id) on delete set null, add constraint analysis_outputs_source_job_run_id_fkey foreign key(source_job_run_id) references ace_hunter.job_runs(id) on delete set null;
alter table ace_hunter.job_runs drop constraint job_runs_parent_run_id_fkey, add constraint job_runs_parent_run_id_fkey foreign key(parent_run_id) references ace_hunter.job_runs(id) on delete set null;
```

The SQL ends with these concrete indexes:

```sql
create unique index if not exists product_repositories_one_primary on ace_hunter.product_repositories(product_id) where is_primary;
create unique index if not exists analysis_outputs_daily_unique on ace_hunter.analysis_outputs(output_type,period_start,period_end) where output_type='daily_report' and user_id is null and product_id is null;
create unique index if not exists analysis_outputs_product_unique on ace_hunter.analysis_outputs(output_type,product_id,period_start,period_end) where output_type='product_analysis' and product_id is not null;
create unique index if not exists analysis_outputs_realtime_unique on ace_hunter.analysis_outputs(output_type,product_id,idempotency_key) where output_type='realtime_observation' and product_id is not null and idempotency_key is not null;
create unique index if not exists repository_snapshots_bucket_unique on ace_hunter.repository_snapshots(repository_id,captured_at,granularity);
create unique index if not exists trending_repo_unique on ace_hunter.github_trending_snapshots(period,language,captured_at,repository_id);
create unique index if not exists trending_rank_unique on ace_hunter.github_trending_snapshots(period,language,captured_at,rank);
create unique index if not exists x_post_product_unique on ace_hunter.product_x_posts(product_id,x_post_id);
create unique index if not exists monitor_user_product_unique on ace_hunter.user_product_monitors(user_id,product_id);
create unique index if not exists job_runs_idempotency_unique on ace_hunter.job_runs(idempotency_key);
alter table ace_hunter.product_repositories add constraint product_repositories_role_check check(role in ('primary','secondary')), add constraint product_repositories_primary_role_check check(not is_primary or role='primary'), add constraint product_repositories_confidence_check check(confidence between 0 and 1);
alter table ace_hunter.products add constraint products_status_check check(status in ('active','inactive'));
alter table ace_hunter.repositories add constraint repositories_owner_type_check check(owner_type is null or owner_type in ('User','Organization')), add constraint repositories_status_check check(status in ('active','inaccessible','deleted'));
alter table ace_hunter.github_trending_snapshots add constraint trending_collection_status_check check(collection_status in ('success','partial'));
alter table ace_hunter.repository_snapshots add constraint repository_snapshots_counts_check check(stars>=0 and (forks is null or forks>=0) and (commits_30d is null or commits_30d>=0) and (pr_total is null or pr_total>=0) and (issues_total is null or issues_total>=0));
alter table ace_hunter.product_x_posts add constraint product_x_posts_type_check check(post_type in ('original','comment','article')), add constraint product_x_posts_sentiment_check check(sentiment is null or sentiment in ('positive','neutral','negative')), add constraint product_x_posts_stance_check check(stance is null or stance in ('support','question','challenge','bug','neutral','spam')), add constraint product_x_posts_scores_check check((relevance_score is null or relevance_score between 0 and 1) and (automation_probability is null or automation_probability between 0 and 1)), add constraint product_x_posts_counts_check check(likes>=0 and reposts>=0 and quotes>=0 and replies>=0 and (bookmarks is null or bookmarks>=0) and (views is null or views>=0)), add constraint product_x_posts_reply_check check(post_type<>'comment' or in_reply_to_post_id is not null);
alter table ace_hunter.user_product_monitors add constraint monitors_status_check check(status in ('active','inactive'));
alter table ace_hunter.analysis_outputs add constraint analysis_outputs_status_check check(status in ('running','complete','partial','failed')), add constraint analysis_outputs_trigger_check check(trigger_type in ('schedule','manual','realtime')), add constraint analysis_outputs_period_check check(period_end>=period_start), add constraint analysis_outputs_time_check check(completed_at is null or completed_at>=started_at), add constraint analysis_outputs_confidence_check check(confidence is null or confidence between 0 and 1);
alter table ace_hunter.job_runs add constraint job_runs_trigger_check check(trigger_type in ('schedule','manual','realtime','user')), add constraint job_runs_status_check check(status in ('running','success','partial','failed')), add constraint job_runs_time_check check(completed_at is null or completed_at>=started_at), add constraint job_runs_counts_check check(attempt between 0 and 2 and coalesce(items_expected,0)>=0 and coalesce(items_succeeded,0)>=0 and coalesce(items_failed,0)>=0 and coalesce(items_skipped,0)>=0), add constraint job_runs_retry_check check(next_attempt_at is null or (status='failed' and completed_at is not null and next_attempt_at>=completed_at and attempt<2));
do $$ declare t text; begin foreach t in array array['products','repositories','product_repositories','repository_snapshots','github_trending_snapshots','product_x_posts','user_product_monitors','analysis_outputs','job_runs'] loop execute format('alter table ace_hunter.%I owner to ace_hunter_owner',t); execute format('revoke all on ace_hunter.%I from public',t); execute format('alter table ace_hunter.%I enable row level security',t); execute format('alter table ace_hunter.%I force row level security',t); execute format('grant select,insert,update,delete on ace_hunter.%I to ace_hunter_runtime',t); execute format('create policy %I on ace_hunter.%I for all to ace_hunter_runtime using (true) with check (true)',t||'_runtime',t); end loop; end $$;
revoke all on schema ace_hunter from public;
grant usage on schema ace_hunter to ace_hunter_runtime;
commit;
```

Database privileges are installed in three explicit phases. `ops/01_bootstrap_roles.sql` is run only through an administrator DSN: it creates the three fixed least-privilege roles, precreates `ace_hunter authorization ace_hunter_owner`, grants `ace_hunter_migrator` membership in the owner role, and grants the owner only `USAGE` on schema `auth` plus `REFERENCES(id)` on `auth.users`; it explicitly verifies `has_table_privilege('ace_hunter_owner','auth.users','select')=false`. Phase two accepts an empty owner-created `ace_hunter` schema or an exact complete manifest, then runs migration through `ACE_HUNTER_MIGRATION_DATABASE_URL` as `ace_hunter_migrator`. Phase three activates runtime login with a protected password. Local and CI execute the same three stages; tests connect as the actual migrator for DDL and actual runtime for application Stores, never as PostgreSQL superuser.

```sql
-- ops/02_activate_runtime_role.sql, invoked as: psql "$ADMIN_URL" --set=runtime_password -f ops/02_activate_runtime_role.sql
\set QUIET 1
\set ECHO none
alter role ace_hunter_runtime login password :'runtime_password';
\unset runtime_password
```

The operator enters `runtime_password` at the protected prompt; it is not passed in shell history. `ops/01_bootstrap_roles.sql` is also idempotent through `DO` blocks that create each role only when absent and then reassert every negative capability.

Every declared status/type column receives an explicit check constraint; counts, rank, scores, confidence, and probabilities reject negative or out-of-range values; `period_end >= period_start`; `completed_at >= started_at`; reply rows require `in_reply_to_post_id`; Primary links require `role='primary'`; and all foreign keys declare deliberate delete behavior (`cascade` only for pure links/snapshots, `restrict` for retained facts/outputs). `tests/integration/db/migrations.test.ts` enumerates `pg_constraint` and fails if the expected constraint names, forced RLS flags, policy roles, owner, or grants differ.

```ts
// src/db/migrate.ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { loadMigrationConfig } from "../config/load-config.js";
import { createHash } from "node:crypto";
import { assertCatalogIsAbsentOrComplete } from "./schema-manifest.js";

export async function migrate(pool: Pool, options: { expectedChecksum: string; sqlOverride?: string }): Promise<void> {
  const path = fileURLToPath(new URL("./migrations/0001_ace_hunter_initial.sql", import.meta.url));
  const sql = options.sqlOverride ?? await readFile(path, "utf8");
  const actual = createHash("sha256").update(sql).digest("hex");
  if (actual !== options.expectedChecksum) throw new Error(`migration checksum mismatch: expected ${options.expectedChecksum} actual ${actual}`);
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('ace_hunter:migrate'))");
    const state = await assertCatalogIsAbsentOrComplete(client);
    if (state === "empty") {
      try { await client.query(sql); }
      catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
    }
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('ace_hunter:migrate'))").catch(() => undefined);
    client.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadMigrationConfig(process.env);
  const pool = new Pool({ connectionString: config.migrationDatabaseUrl });
  migrate(pool, { expectedChecksum: config.migrationSha256 }).finally(() => pool.end());
}
```

`schema-manifest.ts` contains the exact sorted catalog manifest. `assertCatalogIsAbsentOrComplete` returns `empty` for the owner-created schema containing no objects or `complete` for an exact manifest; a complete match exits without DDL. A missing namespace, residual/partial schema, missing constraint/policy/index, wrong owner, or extra object raises `catalog preflight failed`. The migration SQL remains one transaction and explicitly rolls back after an execution error.

```ts
// src/db/client.ts
import { Pool } from "pg";
export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 5, statement_timeout: 60_000 });
}
```

- [ ] **Step 5: Implement stores and their contract test**

Every Store accepts `Pool | PoolClient`, parameterizes values, and returns domain-shaped camelCase objects. The central upsert signature is:

```ts
// src/db/stores/repository-store.ts
import type { Pool, PoolClient } from "pg";
export type Queryable = Pick<Pool | PoolClient, "query">;
export interface RepositoryUpsert {
  githubRepoId: number; githubNodeId?: string; ownerId?: number; ownerLogin: string;
  ownerType?: string; ownerProfileUrl?: string; ownerAvatarUrl?: string; name: string; fullName: string; description?: string;
  repoUrl: string; homepageUrl?: string; defaultBranch: string; language?: string;
  license?: string; topics: string[]; hasReadme: boolean; githubCreatedAt: Date;
  githubPushedAt?: Date; isFork: boolean; isArchived: boolean; isTemplate: boolean; isMirror: boolean;
}
export class RepositoryStore {
  constructor(private readonly db: Queryable) {}
  async upsert(input: RepositoryUpsert): Promise<string> {
    const result = await this.db.query<{ id: string }>(`insert into ace_hunter.repositories
      (github_repo_id,github_node_id,owner_id,owner_login,owner_type,owner_profile_url,owner_avatar_url,name,full_name,description,repo_url,homepage_url,default_branch,language,license,topics,has_readme,github_created_at,github_pushed_at,is_fork,is_archived,is_template,is_mirror,status)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'active')
      on conflict(github_repo_id) do update set description=excluded.description,homepage_url=excluded.homepage_url,topics=excluded.topics,last_synced_at=now(),updated_at=now()
      returning id`, [input.githubRepoId,input.githubNodeId,input.ownerId,input.ownerLogin,input.ownerType,input.ownerProfileUrl,input.ownerAvatarUrl,input.name,input.fullName,input.description,input.repoUrl,input.homepageUrl,input.defaultBranch,input.language,input.license,JSON.stringify(input.topics),input.hasReadme,input.githubCreatedAt,input.githubPushedAt,input.isFork,input.isArchived,input.isTemplate,input.isMirror]);
    return result.rows[0].id;
  }
}
```

`tests/integration/db/stores.test.ts` must insert a Repository twice and assert one row, insert `0` auxiliary values and assert they remain numeric zero, then insert a second snapshot with `null` auxiliary values and assert they remain `null`.

- [ ] **Step 6: Run GREEN database checks**

Run: `ACE_TEST_ADMIN_DATABASE_URL=$ACE_TEST_ADMIN_DATABASE_URL ACE_TEST_MIGRATION_DATABASE_URL=$ACE_TEST_MIGRATION_DATABASE_URL ACE_TEST_RUNTIME_DATABASE_URL=$ACE_TEST_RUNTIME_DATABASE_URL npm test -- --run tests/integration/db && npm run typecheck && npm run lint`

Expected: migration and Store tests PASS; typecheck and lint exit 0. Run `npm run db:migrate` twice against the local database; both executions exit 0 and nine business tables remain.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/db ops/01_bootstrap_roles.sql ops/02_activate_runtime_role.sql tests/integration/db
git commit -m "feat: add ace hunter database schema and stores"
```

### Task 3: Durable job execution, retries, and partial status

**Authoritative durable-execution boundary:** Construct `JobRunner` with an explicit Data Pool, a distinct Lock Pool that has the same hashed connection target fingerprint, and explicit loaded secrets from `loadRedactionRegistry(process.env)`. One Lock Pool Session owns the session-level advisory lock through Claim, Handler, durable Retry Sleep, state transition, and Unlock; the Handler remains free to use the Data Pool even when its maximum size is one. A Retryable failure persists `failed` plus `next_attempt_at` before sleeping. Restart waits only the remaining duration, and `prepareRetry` requires `next_attempt_at <= Clock.now()`; an early wake or clock rollback leaves the row Pending. An orphan `running` row consumes the next Attempt atomically, while an Attempt-2 orphan terminates as `orphan_retry_exhausted`. Live duplicates reuse their current Lock Client and must validate the complete Claim identity before returning. Canonical Parameters are produced in one descriptor-bounded traversal that rejects accessors, sparse arrays, unsupported JSON, controls, sensitive keys, loaded secrets, and raw key/string byte-limit breaches before string escaping. This paragraph supersedes the shorter illustrative snippets below where they differ.

**Files:**
- Create: `src/core/clock.ts`
- Create: `src/core/time-buckets.ts`
- Create: `src/jobs/retry-policy.ts`
- Create: `src/jobs/job-runner.ts`
- Modify: `src/db/stores/job-run-store.ts`
- Test: `tests/unit/jobs/retry-policy.test.ts`
- Test: `tests/integration/jobs/job-runner.test.ts`

- [ ] **Step 1: Write failing retry and idempotency tests**

```ts
// tests/unit/jobs/retry-policy.test.ts
import { expect, it } from "vitest";
import { retryDelayMs } from "../../../src/jobs/retry-policy.js";
it("uses exactly the approved two retry delays", () => {
  expect([1, 2, 3].map(retryDelayMs)).toEqual([300_000, 1_200_000, null]);
});
```

```ts
// tests/integration/jobs/job-runner.test.ts
import { expect, it, vi } from "vitest";
import { JobRunner } from "../../../src/jobs/job-runner.js";

it("runs one handler for the same idempotency key", async () => {
  const execute = vi.fn(async () => ({ expected: 2, succeeded: 1, failed: [{ id: "b", code: "rate_limit" }], skipped: 0 }));
  const runner = new JobRunner(globalThis.testPool);
  const input = { name: "refresh_repo_metrics", triggerType: "schedule" as const, scheduledFor: new Date("2026-07-19T00:00:00Z"), parameters: {} };
  await Promise.all([runner.run(input, execute), runner.run(input, execute)]);
  expect(execute).toHaveBeenCalledTimes(1);
  const row = await globalThis.testPool.query("select status,items_failed from ace_hunter.job_runs where job_name='refresh_repo_metrics'");
  expect(row.rows).toEqual([{ status: "partial", items_failed: 1 }]);
});

it("persists thrown attempts as failed before retrying the same logical run", async () => {
  const sleeps: number[] = []; let calls = 0;
  const runner = new JobRunner(globalThis.testPool, { now: () => new Date("2026-07-19T00:00:00Z"), sleep: async (ms: number) => { sleeps.push(ms); } });
  await runner.runWithRetry({ name: "collect_x_posts", triggerType: "schedule", scheduledFor: new Date("2026-07-19T00:00:00Z"), parameters: {} }, async () => {
    calls += 1; if (calls < 3) throw new Error("temporary source failure");
    return { expected: 1, succeeded: 1, failed: [], skipped: 0 };
  });
  const row = await globalThis.testPool.query("select status,attempt,error_summary from ace_hunter.job_runs where job_name='collect_x_posts'");
  expect(sleeps).toEqual([300_000, 1_200_000]);
  expect(row.rows).toEqual([{ status: "success", attempt: 2, error_summary: null }]);
  expect(calls).toBe(3);
});
```

- [ ] **Step 2: Run RED tests**

Run: `ACE_TEST_DATABASE_URL=$ACE_TEST_DATABASE_URL npm test -- --run tests/unit/jobs/retry-policy.test.ts tests/integration/jobs/job-runner.test.ts`

Expected: FAIL because retry policy and JobRunner modules do not exist.

- [ ] **Step 3: Implement the runner contracts**

```ts
// src/core/clock.ts
export interface Clock { now(): Date; sleep(ms: number): Promise<void>; }
export const systemClock: Clock = { now: () => new Date(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
```

```ts
// src/jobs/retry-policy.ts
export function retryDelayMs(nextAttempt: number): number | null {
  return nextAttempt === 1 ? 300_000 : nextAttempt === 2 ? 1_200_000 : null;
}
```

```ts
// src/jobs/job-runner.ts
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { redact as structuralRedact } from "../core/logger.js";
export interface JobInput { name: string; triggerType: "schedule" | "manual" | "realtime"; scheduledFor: Date; parameters: Record<string, unknown>; dataCutoffAt?: Date; }
export interface FailedItem { id: string; code: string; }
export interface JobResult { expected: number; succeeded: number; failed: FailedItem[]; skipped: number; }
export class JobError extends Error { constructor(readonly code: string,readonly retryable: boolean,readonly safeMessage: string){ super(safeMessage); } }
export class JobRunner {
  constructor(private readonly pool: Pool, private readonly redactForPersistence: (value:string)=>string = structuralRedact) {}
  async run(input: JobInput, handler: () => Promise<JobResult>): Promise<void> {
    const key = createHash("sha256").update(`${input.name}|${input.scheduledFor.toISOString()}|${JSON.stringify(input.parameters)}`).digest("hex");
    const client = await this.pool.connect(); let runId: string | null = null;
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [key]);
      const inserted = await client.query<{ id: string }>(`insert into ace_hunter.job_runs(job_name,trigger_type,scheduled_for,parameters,status,attempt,idempotency_key,started_at)
        values($1,$2,$3,$4,'running',0,$5,now()) on conflict(idempotency_key) do nothing returning id`, [input.name,input.triggerType,input.scheduledFor,JSON.stringify(input.parameters),key]);
      await client.query("commit");
      if (!inserted.rowCount) return;
      runId = inserted.rows[0].id;
      const result = await handler();
      const status = result.failed.length === 0 ? "success" : result.succeeded > 0 ? "partial" : "failed";
      const failedItems=result.failed.map((item)=>({id:item.id,code:allowlistedItemErrorCode(item.code)}));
      await client.query(`update ace_hunter.job_runs set status=$2,completed_at=now(),items_expected=$3,items_succeeded=$4,items_failed=$5,items_skipped=$6,failed_items=$7 where id=$1`, [inserted.rows[0].id,status,result.expected,result.succeeded,result.failed.length,result.skipped,JSON.stringify(failedItems)]);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      const safe=error instanceof JobError ? `${allowlistedJobErrorCode(error.code)}: ${this.redactForPersistence(error.safeMessage)}` : "unexpected_job_error";
      if (runId) await this.pool.query("update ace_hunter.job_runs set status='failed',completed_at=now(),error_summary=$2 where id=$1", [runId,safe]);
      throw error;
    } finally { client.release(); }
  }
}
```

Extend `JobRunner` with `runWithRetry` that retries only typed `JobError.retryable=true`. Item handlers may return only `{id,code}`; the persistence boundary maps `code` through a fixed allowlist and replaces unknown values with `item_failed`, so no producer-controlled message reaches `failed_items`. Production constructs the Runner with `(value) => redact(value, loadRedactionRegistry(process.env))`; persist thrown errors only as allowlisted typed code plus that redacted safeMessage, and map unexpected errors to `unexpected_job_error`. Tests inject database URLs, Authorization, Cookie, API query keys, and loaded env-file secrets into thrown causes and attempted partial item codes, then assert none appear in `error_summary`, `failed_items`, or logs. Validation/authentication errors stop immediately. The integration test proves each transient failed state before retry and final success at attempt 2.

- [ ] **Step 4: Run GREEN job checks**

Run: `ACE_TEST_DATABASE_URL=$ACE_TEST_DATABASE_URL npm test -- --run tests/unit/jobs tests/integration/jobs && npm run typecheck && npm run lint`

Expected: retry, idempotency, concurrent lock, partial status, and three-attempt tests PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/core/clock.ts src/core/time-buckets.ts src/jobs/retry-policy.ts src/jobs/job-runner.ts src/db/stores/job-run-store.ts tests/unit/jobs tests/integration/jobs
git commit -m "feat: add durable idempotent job runner"
```

### Task 4: GitHub source adapter and candidate discovery

**Files:**
- Create: `src/sources/github/github-source.ts`
- Create: `src/sources/github/schemas.ts`
- Create: `src/sources/github/github-http-client.ts`
- Create: `src/sources/github/request-budget.ts`
- Create: `src/sources/github/repository-search.ts`
- Create: `src/products/create-product-from-repo.ts`
- Create: `src/jobs/discover-github-candidates.ts`
- Test: `tests/unit/sources/github/repository-search.test.ts`
- Test: `tests/integration/jobs/discover-github-candidates.test.ts`
- Test: `tests/contract/fixtures/github/search-over-limit.json`

- [ ] **Step 1: Write the failing slice and eligibility tests**

```ts
// tests/unit/sources/github/repository-search.test.ts
import { describe, expect, it } from "vitest";
import { candidateBuckets, splitSearchSlice } from "../../../../src/sources/github/repository-search.js";

describe("GitHub candidate search", () => {
  it("splits an over-limit time slice without gaps", () => {
    const from = new Date("2026-07-01T00:00:00.000Z");
    const to = new Date("2026-07-02T00:00:00.000Z");
    const [left, right] = splitSearchSlice({ from, to, minStars: 10 });
    expect(left.from).toEqual(from);
    expect(left.to.getTime() + 1).toBe(right.from.getTime());
    expect(right.to).toEqual(to);
  });

  it("assigns all matching public candidate buckets", () => {
    expect(candidateBuckets({ createdAt: new Date("2026-07-18T12:00:00Z"), stars: 1_100 }, new Date("2026-07-19T00:00:00Z")))
      .toEqual(["age_1d_stars_10", "age_7d_stars_100", "age_30d_stars_1000"]);
  });
});
```

- [ ] **Step 2: Run RED search tests**

Run: `npm test -- --run tests/unit/sources/github/repository-search.test.ts`

Expected: FAIL because `repository-search.ts` does not exist.

- [ ] **Step 3: Implement GitHub contracts, validated HTTP, and terminating slice logic**

```ts
// src/sources/github/github-source.ts
export interface SearchSlice { from: Date; to: Date; minStars: number; maxStars?: number; }
export interface GitHubRepository {
  githubRepoId: number; nodeId: string; ownerId: number; ownerLogin: string; ownerType: string;
  ownerProfileUrl: string; ownerAvatarUrl: string;
  name: string; fullName: string; description: string | null; repoUrl: string; homepageUrl: string | null;
  defaultBranch: string; language: string | null; license: string | null; topics: string[];
  hasReadme: boolean; createdAt: Date; pushedAt: Date; stars: number; forks: number;
  isFork: boolean; isArchived: boolean; isTemplate: boolean; isMirror: boolean;
}
export interface GitHubSearchPage { totalCount: number; repositories: GitHubRepository[]; hasNextPage: boolean; nextPage: number | null; }
export interface GitHubSource {
  getRateLimit(): Promise<{ remaining: number; resetAt: Date }>;
  searchRepositories(slice: SearchSlice, page: number): Promise<GitHubSearchPage>;
  getRepository(fullName: string): Promise<GitHubRepository>;
}
export interface GitHubSourceOperation extends GitHubSource { close(): void | Promise<void>; }
export interface GitHubSourceFactory { openOperation(): GitHubSourceOperation | Promise<GitHubSourceOperation>; }
```

```ts
// src/sources/github/repository-search.ts
import type { GitHubRepository, GitHubSource, SearchSlice } from "./github-source.js";
export function splitSearchSlice(slice: SearchSlice): [SearchSlice, SearchSlice] {
  const middle = Math.floor((slice.from.getTime() + slice.to.getTime()) / 2);
  if (middle <= slice.from.getTime()) {
    if (slice.maxStars === undefined) throw new Error("Search density requires a stars upper bound");
    const starMiddle = Math.floor((slice.minStars + slice.maxStars) / 2);
    if (starMiddle <= slice.minStars) throw new Error("GitHub Search cannot be completely partitioned");
    return [{ ...slice, maxStars: starMiddle }, { ...slice, minStars: starMiddle + 1 }];
  }
  return [{ ...slice, to: new Date(middle) }, { ...slice, from: new Date(middle + 1) }];
}
export function candidateBuckets(repo: { createdAt: Date; stars: number }, at: Date): string[] {
  const age = at.getTime() - repo.createdAt.getTime();
  return [
    age <= 86_400_000 && repo.stars >= 10 ? "age_1d_stars_10" : null,
    age <= 7 * 86_400_000 && repo.stars >= 100 ? "age_7d_stars_100" : null,
    age <= 30 * 86_400_000 && repo.stars >= 1000 ? "age_30d_stars_1000" : null,
  ].filter((value): value is string => value !== null);
}
export async function searchCompletely(source: GitHubSource, initial: SearchSlice): Promise<GitHubRepository[]> {
  const pending = [initial]; const byId = new Map<number, GitHubRepository>();
  while (pending.length) {
    const slice = pending.pop()!; const first = await source.searchRepositories(slice, 1);
    if (first.totalCount > 1000) { pending.push(...splitSearchSlice(slice)); continue; }
    for (const repo of first.repositories) byId.set(repo.githubRepoId, repo);
    for (let page = 2; page <= Math.ceil(first.totalCount / 100); page += 1) {
      for (const repo of (await source.searchRepositories(slice, page)).repositories) byId.set(repo.githubRepoId, repo);
    }
  }
  return [...byId.values()];
}
```

`github-http-client.ts` builds `created:from..to stars:min..max is:public archived:false mirror:false`. It does not send the undocumented `fork:false`: GitHub Search excludes forks by default unless `fork:true` or `fork:only` is supplied, and response facts are checked again. `GitHubSourceFactory.openOperation()` creates an independent budget/preflight/rate-limit state for each Job execution; open failure is safely mapped, close failure cannot override a primary error, and only a post-success close failure becomes retryable `source_unavailable`. The 4,500-request default covers Search plus up to 1,000 Detail/README pairs without weakening actual GitHub header limits. Every Detail request performs exactly one README request so the non-null database boolean is evidence-backed. Every non-rate-limit success that reports `search` or `core` Remaining zero schedules Reset plus one second before the next request; unknown/missing resource or invalid reset fails closed. The adapter sends required headers, validates with Zod, and follows bounded primary/secondary reset handling, including a size/time/chunk-bounded parse of only GitHub's official secondary-limit message. Token and response body never appear in an Error.

- [ ] **Step 4: Write the failing discovery integration test**

```ts
// tests/integration/jobs/discover-github-candidates.test.ts
import { expect, it } from "vitest";
import { discoverGithubCandidates } from "../../../src/jobs/discover-github-candidates.js";

it("creates separate products and primary links for repos from one owner", async () => {
  const source = fakeGitHubSource([
    githubRepo({ githubRepoId: 10, fullName: "same/a", stars: 110 }),
    githubRepo({ githubRepoId: 11, fullName: "same/b", stars: 120 }),
  ]);
  await discoverGithubCandidates(testDependencies({ source, pool: globalThis.testPool }), new Date("2026-07-19T00:00:00Z"));
  await discoverGithubCandidates(testDependencies({ source, pool: globalThis.testPool }), new Date("2026-07-19T00:00:00Z"));
  const products = await globalThis.testPool.query("select count(*)::int as count from ace_hunter.products");
  const links = await globalThis.testPool.query("select count(*)::int as count from ace_hunter.product_repositories where is_primary");
  expect(products.rows[0].count).toBe(2);
  expect(links.rows[0].count).toBe(2);
});

it("serializes concurrent creation by github_repo_id", async () => {
  const repo = githubRepo({ githubRepoId: 99, fullName: "same/concurrent", stars: 120, ownerProfileUrl: "https://github.com/same", ownerAvatarUrl: "https://avatars.githubusercontent.com/u/99" });
  await Promise.all([createThroughTransaction(globalThis.testPool, repo), createThroughTransaction(globalThis.testPool, repo)]);
  expect((await globalThis.testPool.query("select count(*)::int n from ace_hunter.repositories where github_repo_id=99")).rows[0].n).toBe(1);
  expect((await globalThis.testPool.query("select count(*)::int n from ace_hunter.products p join ace_hunter.product_repositories pr on pr.product_id=p.id join ace_hunter.repositories r on r.id=pr.repository_id where r.github_repo_id=99")).rows[0].n).toBe(1);
});

it("applies 800 warning, 950 review pause, and 1000 hard transaction gates", async () => {
  await seedTrackedRepositories(globalThis.testPool, 799);
  expect(await discoverOne(globalThis.testPool, githubRepo({ githubRepoId: 800 }))).toMatchObject({ capacity: "warning" });
  await seedTrackedRepositories(globalThis.testPool, 950);
  await expect(discoverOne(globalThis.testPool, githubRepo({ githubRepoId: 951 }))).rejects.toThrow(/capacity_review_required/);
  await seedTrackedRepositories(globalThis.testPool, 1000);
  await expect(discoverOne(globalThis.testPool, githubRepo({ githubRepoId: 1001 }), { reviewedOverride: true })).rejects.toThrow(/capacity_hard_limit/);
});

it("serializes capacity checks for different repositories", async () => {
  await seedTrackedRepositories(globalThis.testPool, 999);
  const settled = await Promise.allSettled([discoverOne(globalThis.testPool, githubRepo({ githubRepoId: 2001 }), { reviewedOverride: true }), discoverOne(globalThis.testPool, githubRepo({ githubRepoId: 2002 }), { reviewedOverride: true })]);
  expect(settled.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(settled.filter((x) => x.status === "rejected")).toHaveLength(1);
  expect((await globalThis.testPool.query("select count(*)::int n from ace_hunter.repositories")).rows[0].n).toBe(1000);
});
```

- [ ] **Step 5: Implement Product creation and discovery orchestration**

```ts
// src/products/create-product-from-repo.ts
import type { Pool, PoolClient } from "pg";
import type { GitHubRepository } from "../sources/github/github-source.js";
export async function createProductFromRepo(pool: Pool, repo: GitHubRepository, options: CapacityReviewOptions = {}, afterPersist?: (client: PoolClient,result: ProductFromRepoResult)=>Promise<void>): Promise<ProductFromRepoResult> {
  const client=await pool.connect();
  try {
    await client.query("begin");
    const result=await persistProductFromRepo(client,repo,options);
    if(afterPersist) await afterPersist(client,result);
    await client.query("commit");
    return result;
  } catch(error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}
async function persistProductFromRepo(client: PoolClient, repo: GitHubRepository, options: CapacityReviewOptions): Promise<ProductFromRepoResult> {
  await client.query("select pg_advisory_xact_lock(hashtext('ace_hunter:capacity'))");
  await client.query("select pg_advisory_xact_lock($1)", [repo.githubRepoId]);
  const stored = await client.query<{ id: string }>("select id from ace_hunter.repositories where github_repo_id=$1", [repo.githubRepoId]);
  const count = Number((await client.query("select count(*)::int n from ace_hunter.repositories")).rows[0].n);
  if (!stored.rowCount && count >= 1000) throw new Error("capacity_hard_limit");
  if (!stored.rowCount && count >= 950 && options.reviewedCapacityOverride !== true) throw new Error("capacity_review_required");
  let repositoryId = stored.rows[0]?.id;
  if (!repositoryId) {
    const inserted = await client.query<{ id: string }>(`insert into ace_hunter.repositories(github_repo_id,github_node_id,owner_id,owner_login,owner_type,owner_profile_url,owner_avatar_url,name,full_name,description,repo_url,homepage_url,default_branch,language,license,topics,has_readme,github_created_at,github_pushed_at,is_fork,is_archived,is_template,is_mirror,status)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'active') returning id`, [repo.githubRepoId,repo.nodeId,repo.ownerId,repo.ownerLogin,repo.ownerType,repo.ownerProfileUrl,repo.ownerAvatarUrl,repo.name,repo.fullName,repo.description,repo.repoUrl,repo.homepageUrl,repo.defaultBranch,repo.language,repo.license,JSON.stringify(repo.topics),repo.hasReadme,repo.createdAt,repo.pushedAt,repo.isFork,repo.isArchived,repo.isTemplate,repo.isMirror]);
    repositoryId = inserted.rows[0].id;
  }
  const linked = await client.query<{ product_id: string }>("select product_id from ace_hunter.product_repositories where repository_id=$1", [repositoryId]);
  if (linked.rowCount) return { productId: linked.rows[0].product_id, repositoryId, capacity: count >= 950 ? "reviewed" : count >= 800 ? "warning" : "ok" };
  const product = await client.query<{ id: string }>("insert into ace_hunter.products(name,description,website_url,identifiers,status) values($1,$2,$3,$4,'active') returning id", [repo.name,repo.description,repo.homepageUrl,JSON.stringify({ github_full_names: [repo.fullName], domains: repo.homepageUrl ? [new URL(repo.homepageUrl).hostname] : [] })]);
  await client.query("insert into ace_hunter.product_repositories(product_id,repository_id,role,is_primary,confidence,link_source) values($1,$2,'primary',true,1,'github_discovery')", [product.rows[0].id,repositoryId]);
  return { productId: product.rows[0].id, repositoryId, capacity: count >= 950 ? "reviewed" : count >= 800 ? "warning" : "ok" };
}
```

`discover-github-candidates.ts` executes the three rule searches, refreshes every hit through the detail endpoint, rejects forks/archives/mirrors/inaccessible repositories and repositories missing both a nonblank description and README, then calls the public `createProductFromRepo(pool,...)` API. That API owns BEGIN/COMMIT/ROLLBACK and exposes only a controlled `afterPersist` callback so the Product, Repo, Primary link, first hourly Snapshot, and capacity evidence are atomic. It fixes lock order as global capacity then 64-bit `github_repo_id`. Capacity counts every tracked repository row regardless of status: new count 800+ stores `capacity_status`, `tracked_count`, and `capacity_warning` in Snapshot; the post-commit structured log is best-effort and is neither a notification nor an outbox. Old count 950+ requires a recorded nonempty review id; old count 1000 always rejects new rows. Existing rows may refresh/reactivate and repair links at every threshold without increasing the count.

- [ ] **Step 6: Run GREEN GitHub discovery checks**

Run: `ACE_TEST_DATABASE_URL=$ACE_TEST_DATABASE_URL npm test -- --run tests/unit/sources/github tests/integration/jobs/discover-github-candidates.test.ts && npm run typecheck && npm run lint`

Expected: slice, dense same-second star split, exclusions, no-gap pagination, Product separation, and idempotency tests PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/sources/github src/products/create-product-from-repo.ts src/jobs/discover-github-candidates.ts tests/unit/sources/github tests/integration/jobs/discover-github-candidates.test.ts tests/contract/fixtures/github
git commit -m "feat: discover github candidate repositories"
```

### Task 5: GitHub Trending daily, weekly, and monthly collection

**Files:**
- Create: `src/sources/trending/trending-source.ts`
- Create: `src/sources/trending/parse-trending.ts`
- Create: `src/sources/trending/github-trending-source.ts`
- Create: `src/jobs/collect-github-trending.ts`
- Test: `tests/unit/sources/trending/parse-trending.test.ts`
- Test: `tests/integration/jobs/collect-github-trending.test.ts`
- Create: `tests/contract/fixtures/trending/daily.html`
- Create: `tests/contract/fixtures/trending/weekly.html`
- Create: `tests/contract/fixtures/trending/monthly.html`

- [x] **Step 1: Write a failing structural parser test**

```ts
// tests/unit/sources/trending/parse-trending.test.ts
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parseTrending } from "../../../../src/sources/trending/parse-trending.js";
it("extracts rank, full name, and period stars", async () => {
  const html = await readFile("tests/contract/fixtures/trending/daily.html", "utf8");
  expect(parseTrending(html)).toEqual([{ rank: 1, fullName: "owner/repo", starsInPeriod: 321 }]);
});
it("rejects structural breakage instead of returning an empty ranking", () => {
  expect(() => parseTrending("<html><main>changed</main></html>")).toThrow(/Trending structure/);
});
```

- [x] **Step 2: Run RED Trending tests**

Run: `npm test -- --run tests/unit/sources/trending/parse-trending.test.ts`

Expected: FAIL because the parser module does not exist.

- [x] **Step 3: Implement parser, adapter, and collection job**

First create `tests/integration/jobs/collect-github-trending.test.ts`. With a fake source returning Daily/Weekly/Monthly rows, its core assertions are: all three `parameters.period` values create independently timestamped batches; one failed enrichment yields `partial` plus persisted successful rows; retrying the same scheduled bucket leaves row and `job_runs` counts unchanged; a parser failure persists no ranking rows and a failed Job. The file imports `collectGithubTrending` from the still-missing production module.

```ts
import { collectGithubTrending } from "../../../src/jobs/collect-github-trending.js";
it("persists all periods, partial rows, and an idempotent scheduled batch", async () => {
  for (const period of ["daily","weekly","monthly"] as const) await collectGithubTrending(trendingDeps(),{period,scheduledFor});
  expect(await storedPeriods()).toEqual(["daily","monthly","weekly"]);
  const partial=await collectGithubTrending(trendingDeps({failedFullName:"bad/repo"}),{period:"daily",scheduledFor:nextRun});
  expect(partial.status).toBe("partial"); expect(await successfulRows(nextRun)).toBeGreaterThan(0);
  await collectGithubTrending(trendingDeps(),{period:"daily",scheduledFor});
  expect(await batchCount("daily",scheduledFor)).toBe(1);
});
```

Before implementation run: `ACE_TEST_DATABASE_URL=$ACE_TEST_DATABASE_URL npm test -- --run tests/integration/jobs/collect-github-trending.test.ts`.

Expected: RED with missing `collect-github-trending.ts`; this is separate from the parser RED.

```ts
// src/sources/trending/trending-source.ts
export type TrendingPeriod = "daily" | "weekly" | "monthly";
export interface TrendingEntry { rank: number; fullName: string; starsInPeriod: number | null; }
export interface TrendingSource { collect(period: TrendingPeriod, language: string): Promise<TrendingEntry[]>; }
```

```ts
// src/sources/trending/parse-trending.ts
import { load } from "cheerio";
import type { TrendingEntry } from "./trending-source.js";
export function parseTrending(html: string): TrendingEntry[] {
  const $ = load(html); const articles = $("article.Box-row");
  if (articles.length === 0) throw new Error("Trending structure has no repository rows");
  return articles.toArray().map((node, index) => {
    const href = $(node).find("h2 a").attr("href")?.replace(/^\//, "");
    if (!href || href.split("/").length !== 2) throw new Error("Trending structure has an invalid repository link");
    const periodText = $(node).find("span.d-inline-block.float-sm-right").text();
    const match = periodText.replace(/,/g, "").match(/(\d+)\s+stars?/i);
    return { rank: index + 1, fullName: href, starsInPeriod: match ? Number(match[1]) : null };
  });
}
```

`github-trending-source.ts` fetches only `https://github.com/trending?since=<period>` in V0.1. The `language` column is reserved for a later language-ranking design, so every value except `all` is rejected before network access. The adapter enforces canonical origin, English response text, redirect refusal, timeout, bounded streamed HTML, strict UTF-8, and structural parsing. `collect-github-trending.ts` parses before opening one independent GitHub operation, enriches every valid entry through `GitHubSource.getRepository`, creates missing Product/Repository pairs plus the new Repository's first core Snapshot in one transaction, and atomically replaces one deterministic UTC-hour batch. Item-level missing/invalid repositories yield `partial`; systemic source, capacity, close, or persistence failures write no ranking batch. An all-item failure preserves any prior batch for the same bucket.

- [x] **Step 4: Run GREEN Trending checks**

Run: `ACE_TEST_DATABASE_URL=$ACE_TEST_DATABASE_URL npm test -- --run tests/unit/sources/trending tests/integration/jobs/collect-github-trending.test.ts && npm run typecheck && npm run lint`

Expected: all three period fixtures, structural failure, rank uniqueness, missing Repo enrichment, and idempotent retry tests PASS.

- [x] **Step 5: Commit Task 5**

```bash
git add src/sources/trending src/jobs/collect-github-trending.ts tests/unit/sources/trending tests/integration/jobs/collect-github-trending.test.ts tests/contract/fixtures/trending
git commit -m "feat: collect github trending snapshots"
```

### Task 6: Core and auxiliary GitHub metric refresh

**Files:**
- Create: `src/sources/github/metrics-reader.ts`
- Modify: `src/sources/github/github-source.ts`
- Modify: `src/sources/github/github-http-client.ts`
- Create: `src/jobs/refresh-repo-metrics.ts`
- Create: `src/jobs/retention.ts`
- Test: `tests/unit/sources/github/metrics-reader.test.ts`
- Test: `tests/integration/jobs/refresh-repo-metrics.test.ts`
- Test: `tests/integration/jobs/retention.test.ts`

- [x] **Step 1: Write failing metric timing tests**

```ts
// tests/unit/sources/github/metrics-reader.test.ts
import { expect, it } from "vitest";
import { needsAuxRefresh, normalizeMetrics } from "../../../../src/sources/github/metrics-reader.js";
it("refreshes auxiliary facts only after six hours", () => {
  const now = new Date("2026-07-19T12:00:00Z");
  expect(needsAuxRefresh(new Date("2026-07-19T06:00:00Z"), now)).toBe(true);
  expect(needsAuxRefresh(new Date("2026-07-19T06:00:01Z"), now)).toBe(false);
});
it("keeps confirmed zero distinct from an unavailable field", () => {
  expect(normalizeMetrics({ issuesOpen: 0 }).issuesOpen).toBe(0);
  expect(normalizeMetrics({}).issuesOpen).toBeNull();
});
```

Also create both integration files before any production implementation:

```ts
// tests/integration/jobs/refresh-repo-metrics.test.ts
import { refreshRepoMetrics } from "../../../src/jobs/refresh-repo-metrics.js";
it("reuses the UTC bucket, preserves stale aux capture time, and marks budget exhaustion partial", async () => {
  const first=await refreshRepoMetrics(metricDeps({ auxBudget:false }), scheduledAt);
  const retry=await refreshRepoMetrics(metricDeps({ auxBudget:true }), scheduledAt);
  expect(first.status).toBe("partial"); expect(retry.snapshotId).toBe(first.snapshotId);
  expect(await snapshotCount(repositoryId,scheduledAt)).toBe(1);
});

// tests/integration/jobs/retention.test.ts
import { compactSnapshots } from "../../../src/jobs/retention.js";
it("creates a daily survivor before deleting hourly facts older than 90 days", async () => {
  await seedHourlyFactsAroundCutoff(); await compactSnapshots(globalThis.testPool, now);
  expect(await dailySurvivorCount()).toBe(1); expect(await oldHourlyCount()).toBe(0);
});
```

- [x] **Step 2: Run RED metric tests**

Run: `ACE_TEST_DATABASE_URL=$ACE_TEST_DATABASE_URL npm test -- --run tests/unit/sources/github/metrics-reader.test.ts tests/integration/jobs/refresh-repo-metrics.test.ts tests/integration/jobs/retention.test.ts`

Expected: RED for missing metric reader, refresh job, and retention job; each test file must fail for its own missing production module before implementation.

- [x] **Step 3: Implement exact metric contracts and refresh behavior**

```ts
// additions to src/sources/github/github-source.ts
export interface CoreMetrics { stars: number; forks: number; metadata: GitHubRepository; capturedAt: Date; }
export interface AuxMetrics {
  commits30d: number; prTotal: number; prOpen: number; prMerged: number;
  releasesCount: number; latestReleaseAt: Date | null; latestReleaseTag: string | null;
  issuesTotal: number; issuesOpen: number; issuesClosed: number; capturedAt: Date;
}
```

```ts
// src/sources/github/metrics-reader.ts
export function needsAuxRefresh(last: Date | null, now: Date): boolean {
  return last === null || now.getTime() - last.getTime() >= 6 * 60 * 60 * 1000;
}
export function normalizeMetrics(input: { issuesOpen?: number }) {
  return { issuesOpen: input.issuesOpen ?? null };
}
```

`GitHubSource.getCoreMetrics` reads Repository metadata, Stars, and Forks. `getAuxMetrics` reads commits on the default branch since `capturedAt - 30 days`, mutually exclusive OPEN/CLOSED/MERGED PR counts, issues with Pull Requests excluded, and published non-draft Releases including prereleases. Release pagination is complete up to a deliberate 1,000-item safety boundary; larger repositories fail that Aux item closed instead of storing a truncated count. `refresh-repo-metrics.ts` fixes the observation time at job start, accepts an hourly run only in the same UTC hour as `scheduledFor`, reuses the scheduled UTC bucket on retry, refreshes Aux only when stale, carries prior Aux values with the prior `aux_metrics_captured_at`, and marks an item partial when request budget permits Core but not Aux. Realtime snapshots use the actual observation timestamp and `granularity='realtime'`. Snapshot upserts independently enforce monotonic Core observation time and Aux capture time, so an older response cannot overwrite newer evidence in the same bucket.

- [x] **Step 4: Add retention safety behavior**

```ts
// src/jobs/retention.ts
import type { Pool } from "pg";
export async function compactSnapshots(pool: Pool, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 90 * 86_400_000);
  await pool.query(`insert into ace_hunter.repository_snapshots(repository_id,captured_at,granularity,stars,forks,commits_30d,pr_total,pr_open,pr_merged,releases_count,latest_release_at,latest_release_tag,issues_total,issues_open,issues_closed,aux_metrics_captured_at,candidate_buckets,candidate_rule_version,collected_fields)
    select distinct on(repository_id,date_trunc('day',captured_at)) repository_id,date_trunc('day',captured_at),'daily',stars,forks,commits_30d,pr_total,pr_open,pr_merged,releases_count,latest_release_at,latest_release_tag,issues_total,issues_open,issues_closed,aux_metrics_captured_at,candidate_buckets,candidate_rule_version,collected_fields
    from ace_hunter.repository_snapshots where granularity='hourly' and captured_at < $1 order by repository_id,date_trunc('day',captured_at),captured_at desc on conflict do nothing`, [cutoff]);
  const deleted = await pool.query(`delete from ace_hunter.repository_snapshots h where h.granularity='hourly' and h.captured_at < $1 and exists(select 1 from ace_hunter.repository_snapshots d where d.repository_id=h.repository_id and d.granularity='daily' and d.captured_at=date_trunc('day',h.captured_at))`, [cutoff]);
  await pool.query("delete from ace_hunter.job_runs where created_at < $1", [cutoff]);
  return deleted.rowCount ?? 0;
}
```

- [x] **Step 5: Run GREEN metric and retention checks**

Run: `ACE_TEST_DATABASE_URL=$ACE_TEST_DATABASE_URL npm test -- --run tests/unit/sources/github/metrics-reader.test.ts tests/integration/jobs/refresh-repo-metrics.test.ts tests/integration/jobs/retention.test.ts && npm run typecheck && npm run lint`

Expected: exact 30-day boundary, default-branch-only commits, PR/Issue separation, draft Release exclusion, stale Aux reuse, bucket retry, Core-first budget, and safe compaction tests PASS.

Actual: focused PostgreSQL tests, the full local suite, typecheck, lint, build, and `git diff --check` passed. The opt-in live contract also read `github/docs` through real GitHub Core REST and GraphQL endpoints and verified metric invariants. Retention uses one advisory-locked transaction, exact `now - 90 days`, UTC daily buckets, late-arrival replacement, and preserves running Job Runs.

- [ ] **Step 6: Commit Task 6**

```bash
git add src/sources/github src/jobs/refresh-repo-metrics.ts src/jobs/retention.ts tests/unit/sources/github/metrics-reader.test.ts tests/integration/jobs/refresh-repo-metrics.test.ts tests/integration/jobs/retention.test.ts
git commit -m "feat: refresh and retain github repository metrics"
```

### Task 7: X collection, deduplication, model analysis, and comments

**Files:**
- Create: `src/sources/x/x-source.ts`
- Create: `src/sources/x/schemas.ts`
- Create: `src/sources/x/query-builder.ts`
- Create: `src/sources/x/twitter-cli-source.ts`
- Create: `src/analysis/content-analyzer.ts`
- Create: `src/analysis/model-content-analyzer.ts`
- Create: `src/analysis/deduplicate-posts.ts`
- Create: `src/jobs/collect-x-posts.ts`
- Create: `src/jobs/analyze-x-posts.ts`
- Create: `src/jobs/collect-x-comments.ts`
- Test: `tests/unit/sources/x/query-builder.test.ts`
- Test: `tests/unit/analysis/deduplicate-posts.test.ts`
- Test: `tests/contract/sources/x-source.test.ts`
- Test: `tests/contract/sources/x-live.test.ts`
- Test: `tests/integration/jobs/x-pipeline.test.ts`

- [x] **Step 1: Write failing query, limit, and status tests**

```ts
// tests/unit/sources/x/query-builder.test.ts
import { expect, it } from "vitest";
import { buildProductQueries } from "../../../../src/sources/x/query-builder.js";
it("orders precise identifiers and rejects a bare generic name", () => {
  expect(buildProductQueries({ name: "Open", fullName: "o/open", repoUrl: "https://github.com/o/open", domain: "open.dev", isGenericName: true }))
    .toEqual(['"https://github.com/o/open"', '"o/open"', '"open.dev"', '"Open" GitHub', '"Open" "open source"']);
});
```

```ts
// tests/integration/jobs/x-pipeline.test.ts
import { expect, it } from "vitest";
import { collectXPosts } from "../../../src/jobs/collect-x-posts.js";
it("persists success with zero results distinctly from source failure", async () => {
  await collectXPosts(xDependencies({ searchResult: [] }), productId, new Date("2026-07-19T00:00:00Z"));
  let row = await globalThis.testPool.query("select x_collection_status from ace_hunter.products where id=$1", [productId]);
  expect(row.rows[0].x_collection_status).toBe("success_empty");
  await expect(collectXPosts(xDependencies({ error: new Error("rate limit") }), productId, new Date("2026-07-19T01:00:00Z"))).rejects.toThrow();
  row = await globalThis.testPool.query("select x_collection_status,x_last_error_code from ace_hunter.products where id=$1", [productId]);
  expect(row.rows[0]).toEqual({ x_collection_status: "unavailable", x_last_error_code: "source_unavailable" });
});

it("analyzes persisted comments after collection", async () => {
  await collectXComments(xDependencies({ replies: [xReply({ id: "reply-1", rootPostId: "root-1" }) }), productId, "root-1");
  const stored = await globalThis.testPool.query("select id,analyzed_at,relevance_score from ace_hunter.product_x_posts where x_post_id='reply-1'");
  expect(stored.rows).toHaveLength(1);
  expect(stored.rows[0].analyzed_at).not.toBeNull();
  expect(stored.rows[0].relevance_score).not.toBeNull();
});

it("rejects bad auth/version but accepts a legal empty search", async () => {
  await expect(assertTwitterCliVersion(fakeExec({ stdout: "twitter-cli 0.8.4\n" }))).rejects.toThrow(/twitter_cli_version/);
  await expect(assertTwitterCliVersion(fakeExec({ stdout: "twitter-cli 0.8.5\n" }))).resolves.toBeUndefined();
  await expect(parseTwitterEnvelope({ ok: false, schema_version: "1", data: [] }, "status")).rejects.toThrow(/twitter_auth_required/);
  await expect(parseTwitterEnvelope({ ok: true, schema_version: "0", data: [{}] }, "search")).rejects.toThrow(/twitter_schema_version/);
  await expect(parseTwitterEnvelope({ ok: true, schema_version: "1", data: [] }, "search")).resolves.toEqual([]);
});
```

- [x] **Step 2: Run RED X tests**

Run: `ACE_TEST_DATABASE_URL=$ACE_TEST_DATABASE_URL npm test -- --run tests/unit/sources/x tests/unit/analysis/deduplicate-posts.test.ts tests/integration/jobs/x-pipeline.test.ts`

Expected: FAIL because X source, query builder, deduplication, and jobs do not exist.

- [x] **Step 3: Implement source and analysis contracts**

```ts
// src/sources/x/x-source.ts
export interface XPostFact {
  id: string; conversationId: string; rootPostId: string; inReplyToPostId: string | null;
  authorId: string; authorUsername: string; authorName: string; authorVerified: boolean;
  content: string; language: string | null; url: string; createdAt: Date;
  likes: number; reposts: number; quotes: number; replies: number; bookmarks: number | null; views: number | null;
}
export interface XSearchInput { query: string; since: Date; until: Date; limit: number; }
export interface XSourceAdapter {
  capabilities(): { recentSearchDays: number; replies: boolean };
  assertAuthenticated(): Promise<void>;
  searchPosts(input: XSearchInput): Promise<XPostFact[]>;
  searchReplies(conversationId: string, since: Date, limit: number): Promise<XPostFact[]>;
  getArticle(tweetId: string): Promise<{ articleText: string }>;
}
```

`TwitterCliSource.assertAuthenticated()` first executes the configured binary with `--version` and requires the parsed semantic version to equal `0.8.5`; it then executes `status --json` and validates the same command-specific envelope parser used by search, Tweet, conversation, and article operations. An envelope `schema_version` check never substitutes for the binary version check.

```ts
// src/analysis/content-analyzer.ts
export interface PostAnalysis {
  postId: string; relevanceScore: number; topic: string; sentiment: "positive" | "neutral" | "negative";
  stance: "support" | "question" | "challenge" | "bug" | "neutral" | "spam";
  automationProbability: number; isProjectAffiliated: boolean;
}
export interface ContentAnalyzer {
  analyze(posts: ReadonlyArray<{ id: string; text: string; authorUsername: string }>): Promise<PostAnalysis[]>;
}
```

`twitter-cli-source.ts` executes only the configured `TWITTER_CLI_PATH` with `spawn`, never through a shell. Every command must return `{ ok: true, schema_version: "1", data }`; `status` additionally requires `data.authenticated=true`. A normal production search may legally return `data=[]` and maps to `success_empty`; only the opt-in live fixture search requires nonempty data. `tweet` requires a nonempty conversation containing the requested root, and `article` requires nonempty `articleText`. Zod rejects wrong version/auth/shape, timeout, or nonzero exit with typed sanitized errors. Search results are capped and mapped to canonical URLs.

Adapter construction first runs `twitter --version`, requires exact semantic version `0.8.5`, then runs authenticated status. Contract tests return `0.8.4`, `0.8.5`, and `0.9.0` and assert only `0.8.5` proceeds.

The contract suite includes an opt-in real fixture gate using `E2E_X_REPO_QUERY` defaulting to `"https://github.com/xai-org/grok-build"`, `E2E_X_ROOT_TWEET_ID` defaulting to `2078468415967367298`, and `E2E_X_ARTICLE_TWEET_ID` defaulting to `2078268943345803407`. At review time the search returned five records, the root conversation returned five items including the root, and the Article returned nonempty `articleText`. The test asserts only current invariants—envelope `ok=true`, `schema_version='1'`, nonempty `data`, requested root present, and nonempty Article text. If a public fixture disappears, fail as `fixture_unavailable` and replace it with another manually verified public ID; never substitute a mock for this real gate.

`model-content-analyzer.ts` sends a native `fetch` request to `DEEPSEEK_BASE_URL`, authenticates with `ACE_HUNTER_DEEPSEEK_API_KEY`, and records `DEEPSEEK_MODEL`. DeepSeek's documented Chat Completions contract accepts `response_format.type='json_object'`, not OpenAI's `json_schema` response type; the adapter therefore embeds the exact JSON Schema in the system prompt, enables JSON Output, and enforces that schema locally with Zod. This behavior is covered by both request-shape tests and a real DeepSeek contract. It accepts only one analysis for every requested ID, validates scores within `[0,1]`, records `analysis_version='x-v1'`, and retries malformed model output at most twice before returning a typed partial failure.

- [x] **Step 4: Implement the exact X pipeline rules**

```ts
// src/analysis/deduplicate-posts.ts
import type { XPostFact } from "../sources/x/x-source.js";
function normalized(text: string): string { return text.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim(); }
export function deduplicatePosts(posts: XPostFact[]): Array<XPostFact & { duplicateClusterId: string | null }> {
  const seen = new Map<string, string>();
  return posts.map((post) => {
    const key = normalized(post.content); const cluster = seen.get(key);
    if (!cluster) seen.set(key, post.id);
    return { ...post, duplicateClusterId: cluster ?? null };
  });
}
```

`collect-x-posts.ts` uses the five ordered queries, excludes Retweets, backfills seven days on first success, overlaps six hours thereafter, deduplicates by `x_post_id` and normalized content across both the current and retained prior collections, saves no more than 50 candidates, expands Article bodies exposed by the CLI, and updates all four Product X status fields in the same transaction: nonempty success is `success_with_results`, empty success is `success_empty`, a typed CLI failure is `unavailable`, and an untouched Product remains `not_collected`. Overlap refreshes cannot turn a Post into a duplicate of itself. `analyze-x-posts.ts` analyzes at most 30 nonduplicate candidates, persists validated partial model results without losing facts, and excludes relevance below `0.6` from reporting without deleting the fact. `collect-x-comments.ts` selects the five highest relevant eligible original posts, skips originals with fewer than three replies, saves no more than 20 replies per original, then invokes the same versioned `ContentAnalyzer` for the persisted Comment rows and writes their relevance/topic/sentiment/stance fields. Comment collection and analysis remain outside realtime first response but must finish in the scheduled pipeline.

- [x] **Step 5: Run GREEN X checks**

Run:

```bash
ACE_TEST_DATABASE_URL=$ACE_TEST_DATABASE_URL npm test -- --run tests/unit/sources/x tests/unit/analysis/deduplicate-posts.test.ts tests/contract/sources/x-source.test.ts tests/integration/jobs/x-pipeline.test.ts
RUN_LIVE_X_CONTRACT=1 npm test -- --run tests/contract/sources/x-live.test.ts
npm run typecheck
npm run lint
```

Expected: query order, generic-name safety, seven-day/overlap windows, 50/30/5/20 limits, Retweet removal, duplicate clustering, relevance threshold, malformed-model retries, persisted Comment analysis, envelope/auth/version/empty-data failures, four collection statuses, and all three real replaceable twitter fixtures PASS. `fixture_unavailable` is a failing result.

Actual: 40 focused unit/contract/integration tests passed, followed by the 269-test full local suite, typecheck, lint, build, and `git diff --check`. The real authenticated `twitter-cli 0.8.5` contract passed status, nonempty Repository search, conversation, and Article fixtures. A real DeepSeek request initially proved that `json_schema` response format is rejected with HTTP 400; the adapter was corrected to the provider's documented `json_object` contract plus local strict Zod enforcement, after which the live versioned classification contract passed. A separate 47-second live database contract completed the real X search → PostgreSQL fact/status persistence → real DeepSeek analysis → versioned analysis persistence chain. The child CLI receives only an allowlisted runtime/network environment, not database, GitHub, or model credentials. Final independent re-review found no remaining P0–P2 issues.

- [x] **Step 6: Commit Task 7**

```bash
git add src/sources/x src/analysis/content-analyzer.ts src/analysis/model-content-analyzer.ts src/analysis/deduplicate-posts.ts src/jobs/collect-x-posts.ts src/jobs/analyze-x-posts.ts src/jobs/collect-x-comments.ts tests/unit/sources/x tests/unit/analysis/deduplicate-posts.test.ts tests/contract/sources/x-source.test.ts tests/contract/sources/x-live.test.ts tests/integration/jobs/x-pipeline.test.ts
git commit -m "feat: collect and analyze x discussions"
```

### Task 8: Deterministic candidate pools and Attention Score

**Files:**
- Create: `src/analysis/percentiles.ts`
- Create: `src/analysis/scoring.ts`
- Create: `src/reports/report-data.ts`
- Test: `tests/unit/analysis/scoring.test.ts`
- Test: `tests/integration/reports/report-data.test.ts`

- [x] **Step 1: Write the failing golden score test**

```ts
// tests/unit/analysis/scoring.test.ts
import { expect, it } from "vitest";
import { rankCandidates } from "../../../src/analysis/scoring.js";

it("computes the approved weighted score", () => {
  const result = rankCandidates([
    { productId: "a", stars: 120, stars24hAgo: 100, repoAgeHours: 48, xStatus: "success_with_results", xPosts: 2, xAuthors: 2, xEngagement: 20, trending: [] },
    { productId: "b", stars: 240, stars24hAgo: 200, repoAgeHours: 48, xStatus: "success_with_results", xPosts: 1, xAuthors: 1, xEngagement: 10, trending: ["weekly"] },
  ], "success");
  expect(result.map((x) => [x.productId, x.githubMomentum, x.xAttention, x.trendingSignal, x.attentionScore]))
    .toEqual([["b", 100, 50, 70, 87], ["a", 70, 100, 0, 69]]);
});

it("distinguishes empty X success from a source-wide X failure", () => {
  expect(rankCandidates([{ productId: "a", stars: 10, stars24hAgo: null, repoAgeHours: 6, xStatus: "success_empty", xPosts: 0, xAuthors: 0, xEngagement: 0, trending: [] }], "success")[0].xAttention).toBe(0);
  expect(rankCandidates([{ productId: "a", stars: 10, stars24hAgo: null, repoAgeHours: 6, xStatus: "unavailable", xPosts: 0, xAuthors: 0, xEngagement: 0, trending: ["daily"] }], "unavailable")[0].attentionScore).toBe(100);
});

it("uses only successful Products for X percentiles during a mixed partial run", () => {
  const ranked = rankCandidates([
    { productId: "low", stars: 20, stars24hAgo: 10, repoAgeHours: 48, xStatus: "success_with_results", xPosts: 1, xAuthors: 1, xEngagement: 1, trending: [] },
    { productId: "high", stars: 20, stars24hAgo: 10, repoAgeHours: 48, xStatus: "success_with_results", xPosts: 2, xAuthors: 2, xEngagement: 2, trending: [] },
    { productId: "failed", stars: 20, stars24hAgo: 10, repoAgeHours: 48, xStatus: "unavailable", xPosts: 999, xAuthors: 999, xEngagement: 999, trending: [] },
  ], "partial");
  expect(ranked.find((x) => x.productId === "high")?.xAttention).toBe(100);
  expect(ranked.find((x) => x.productId === "low")?.xAttention).toBe(50);
  expect(ranked.find((x) => x.productId === "failed")?.xAttention).toBeNull();
});
```

- [x] **Step 2: Run the RED score test**

Run: `npm test -- --run tests/unit/analysis/scoring.test.ts`

Expected: FAIL with `Cannot find module '../../../src/analysis/scoring.js'`.

- [x] **Step 3: Implement CUME_DIST and scoring as pure code**

```ts
// src/analysis/percentiles.ts
export function cumeDist(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  const ordered = [...values].sort((a, b) => a - b);
  return values.map((value) => 100 * (ordered.lastIndexOf(value) + 1) / ordered.length);
}
```

```ts
// src/analysis/scoring.ts
import { cumeDist } from "./percentiles.js";
type XStatus = "success_with_results" | "success_empty" | "unavailable";
type Period = "daily" | "weekly" | "monthly";
export interface ScoreInput { productId: string; stars: number; stars24hAgo: number | null; repoAgeHours: number; xStatus: XStatus; xPosts: number; xAuthors: number; xEngagement: number; trending: Period[]; }
export interface ScoreOutput extends ScoreInput { deltaStars24h: number | null; growthRate24h: number | null; githubMomentum: number; xAttention: number | null; trendingSignal: number; attentionScore: number; }

export function rankCandidates(input: readonly ScoreInput[], xRunStatus: "success" | "partial" | "unavailable"): ScoreOutput[] {
  const deltas = input.map((x) => x.stars24hAgo === null ? x.stars / Math.max(x.repoAgeHours, 6) : x.stars - x.stars24hAgo);
  const growth = input.map((x, i) => x.stars24hAgo === null ? deltas[i] : deltas[i] / Math.max(x.stars24hAgo, 20));
  const deltaPct = cumeDist(deltas), growthPct = cumeDist(growth);
  const successfulIndexes = input.map((x, i) => x.xStatus === "unavailable" ? -1 : i).filter((i) => i >= 0);
  const xPercentiles = (field: "xPosts" | "xAuthors" | "xEngagement") => { const values = successfulIndexes.map((i) => input[i][field]); const pct = cumeDist(values); return new Map(successfulIndexes.map((i, n) => [i, pct[n]])); };
  const postPct = xPercentiles("xPosts"), authorPct = xPercentiles("xAuthors"), engagementPct = xPercentiles("xEngagement");
  return input.map((x, i) => {
    const githubMomentum = 0.6 * deltaPct[i] + 0.4 * growthPct[i];
    const xAttention = x.xStatus === "unavailable" ? null : x.xPosts === 0 ? 0 : 0.5 * postPct.get(i)! + 0.3 * authorPct.get(i)! + 0.2 * engagementPct.get(i)!;
    const trendingSignal = x.trending.includes("daily") ? 100 : x.trending.includes("weekly") ? 70 : x.trending.includes("monthly") ? 40 : 0;
    const attentionScore = xRunStatus === "unavailable" ? 0.875 * githubMomentum + 0.125 * trendingSignal : 0.7 * githubMomentum + 0.2 * (xAttention ?? 0) + 0.1 * trendingSignal;
    return { ...x, deltaStars24h: x.stars24hAgo === null ? null : deltas[i], growthRate24h: x.stars24hAgo === null ? null : growth[i], githubMomentum, xAttention, trendingSignal, attentionScore };
  }).sort((a, b) => b.attentionScore - a.attentionScore || b.stars - a.stars || a.productId.localeCompare(b.productId));
}
```

`xRunStatus` is read from the latest X collection Job at/before cutoff, not inferred from post counts: all product queries completed is `success`, a mix of completed and failed product queries is `partial`, and no product query completed is `unavailable`. X percentiles use only Products with `success_with_results` or `success_empty`; failed Products neither contribute values nor receive an X percentile. Only global `unavailable` reweights GitHub/Trending. A partial run retains normal global weights and gives the failed Product a missing X component of zero, preventing missing data from improving rank.

Golden correction: both example Products have the same 24-hour growth rate (`0.2`), so the approved CUME_DIST tie rule gives both a growth percentile of 100. Therefore Product A's GitHub Momentum is `0.6×50 + 0.4×100 = 70` and its Attention Score is `69`; the earlier `50/55` expectation contradicted the formula and tie rule.

- [x] **Step 4: Implement the cutoff-safe report dataset query and test it**

```ts
// src/reports/report-data.ts
import type { Pool } from "pg";
export async function loadReportCandidates(pool: Pool, cutoff: Date) {
  return (await pool.query(`with latest as (
    select distinct on (repository_id) * from ace_hunter.repository_snapshots where captured_at <= $1 order by repository_id,captured_at desc
  ), primary_repo as (
    select pr.product_id,pr.repository_id from ace_hunter.product_repositories pr where pr.is_primary
  ), last_successful_batch as (
    select period,language,max(captured_at) captured_at from ace_hunter.github_trending_snapshots where captured_at <= $1 and collection_status='success' group by period,language
  ), current_trend as (
    select t.repository_id,t.period from ace_hunter.github_trending_snapshots t join last_successful_batch b using(period,language,captured_at)
  ), first_trend as (
    select repository_id,min(captured_at) first_trending_at from ace_hunter.github_trending_snapshots where collection_status='success' and captured_at <= $1 group by repository_id
  ) select p.id as product_id,r.id as repository_id,l.stars,
    case when ($1-r.github_created_at <= interval '1 day' and l.stars>=10) or ($1-r.github_created_at <= interval '7 days' and l.stars>=100) or ($1-r.github_created_at <= interval '30 days' and l.stars>=1000) then true else false end as candidate_at_cutoff,
    coalesce(array_agg(distinct t.period) filter(where t.period is not null),'{}') as trending,ft.first_trending_at
    from ace_hunter.products p join primary_repo pr on pr.product_id=p.id join ace_hunter.repositories r on r.id=pr.repository_id
    join latest l on l.repository_id=r.id left join current_trend t on t.repository_id=r.id left join first_trend ft on ft.repository_id=r.id
    where (($1-r.github_created_at <= interval '1 day' and l.stars>=10) or ($1-r.github_created_at <= interval '7 days' and l.stars>=100) or ($1-r.github_created_at <= interval '30 days' and l.stars>=1000) or t.period is not null)
    group by p.id,r.id,l.stars,r.github_created_at,ft.first_trending_at`, [cutoff])).rows;
}
```

`tests/integration/reports/report-data.test.ts` inserts a monitor-only Repo, a Product with Primary and Secondary Repos, a Repo that appeared only in an old Trending batch, a currently Trending candidate, a never-Trending candidate, and a Repo whose first Trending snapshot is after the report cutoff. It also stores a stale `candidate_buckets` value that disagrees with cutoff facts. Assert monitor-only is absent; Secondary snapshots cannot change Product score; old history does not set current Signal; a first appearance at or before cutoff excludes the Repo from pre-Trending evaluation; a future first appearance does not leak backward; current membership comes only from the last successful batch; eligibility is recalculated at cutoff; and the 24-hour reference snapshot is nearest within 90 minutes.

- [x] **Step 5: Run GREEN ranking checks**

Run: `ACE_TEST_DATABASE_URL=$ACE_TEST_DATABASE_URL npm test -- --run tests/unit/analysis/scoring.test.ts tests/integration/reports/report-data.test.ts && npm run typecheck && npm run lint`

Expected: PASS for golden arithmetic, tied CUME_DIST values, single-candidate 100, cold start, monitor exclusion, Primary-only scoring, X status behavior, and prediction-leakage exclusion.

Actual: 19 focused tests passed. The dataset derives global X availability by aggregating all terminal per-Product runs in the latest scheduled batch, prevents a late older JobRun from replacing a newer batch, reconstructs each Product's pre-cutoff X status from `parameters.productId` lineage and `items_expected`, rejects unsafe JavaScript integers, and conservatively excludes X metrics that cannot be proven at the cutoff. Repository facts require both the scheduled bucket and actual `observed_at` (or creation time) to be at/before cutoff; Trending facts with lineage require the source Job to have completed by cutoff. The first independent review found these two cutoff-leakage risks; both were fixed and the follow-up review found no remaining P0–P2 issues.

- [x] **Step 6: Commit Task 8**

```bash
git add src/analysis/percentiles.ts src/analysis/scoring.ts src/reports/report-data.ts tests/unit/analysis/scoring.test.ts tests/integration/reports/report-data.test.ts
git commit -m "feat: rank product candidates with attention score"
```

### Task 9: Daily report, project output, and replayable Markdown

**Files:**
- Create: `src/analysis/representative-posts.ts`
- Create: `src/reports/daily-report.ts`
- Create: `src/reports/product-report.ts`
- Create: `src/reports/markdown-renderer.ts`
- Create: `src/jobs/generate-report.ts`
- Test: `tests/unit/reports/daily-report.test.ts`
- Test: `tests/unit/reports/markdown-renderer.test.ts`
- Test: `tests/integration/jobs/generate-report.test.ts`

- [x] **Step 1: Write failing evidence-bound report tests**

```ts
// tests/unit/reports/daily-report.test.ts
import { expect, it } from "vitest";
import { buildDailyReport } from "../../../src/reports/daily-report.js";

const candidates = Array.from({ length: 12 }, (_, index) => ({
  productId: `p${index}`, conclusion: `结论${index}`, score: { attentionScore: 100 - index }, githubFacts: {}, xFacts: {},
  representativePosts: [{ url: `https://x.com/a/status/${index}`, category: "real_usage" }, { url: `https://x.com/b/status/${index}`, category: "analysis" }, { url: `https://x.com/c/status/${index}`, category: "launch" }], risks: [],
}));

it("returns Top 10, two links, and no unsupported platform trend", () => {
  const report = buildDailyReport({ dataCutoffAt: new Date("2026-07-19T00:00:00Z"), facts: { scannedRepos: 12 }, candidates, summaryClaims: [{ text:"一个证据不足的趋势",evidence:[{ productId:"p0",authorId:"a0",isProjectAffiliated:false }] }], evaluationProductIds: ["p0"], baselineProductIds: ["p0"] });
  expect(report.items).toHaveLength(10);
  expect(report.items.every((item) => item.representativePosts.length === 2)).toBe(true);
  expect(report.platformSummary).toBeNull();
});
```

```ts
// tests/unit/reports/markdown-renderer.test.ts
import { expect, it } from "vitest";
import { renderDailyReport } from "../../../src/reports/markdown-renderer.js";
it("labels model judgment and X unavailability", () => {
  const text = renderDailyReport({ dataCutoffAt: "2026-07-19T00:00:00.000Z", facts: {}, platformSummary: null, evaluationProductIds: [], baselineProductIds: [], items: [{ productId: "p", conclusion: "值得观察", score: { attentionScore: 80 }, githubFacts: { stars: 100 }, xFacts: { status: "unavailable", sentiment: { positive: 1 } }, representativePosts: [], risks: ["数据源不完整"] }] });
  expect(text).toContain("X 数据不可用");
  expect(text).toContain("情绪（模型判断）");
});
```

- [x] **Step 2: Run the RED report tests**

Run: `npm test -- --run tests/unit/reports`

Expected: FAIL with missing `daily-report.ts` and `markdown-renderer.ts` modules.

- [x] **Step 3: Implement fixed report contracts and evidence gates**

```ts
// src/reports/daily-report.ts
export interface DailyReportItem { productId: string; conclusion: string; score: Record<string, number>; githubFacts: Record<string, unknown>; xFacts: Record<string, unknown>; representativePosts: Array<{ url: string; category: string }>; risks: string[]; }
export interface DailyReport { dataCutoffAt: string; facts: Record<string, number>; platformSummary: string | null; items: DailyReportItem[]; evaluationProductIds: string[]; baselineProductIds: string[]; }
export interface SummaryClaim { text: string; evidence: Array<{ productId: string; authorId: string; isProjectAffiliated: boolean }>; }
export function buildDailyReport(input: { dataCutoffAt: Date; facts: Record<string, number>; candidates: DailyReportItem[]; summaryClaims: SummaryClaim[]; evaluationProductIds: string[]; baselineProductIds: string[] }): DailyReport {
  const supportedClaims=input.summaryClaims.filter((claim)=>new Set(claim.evidence.map((e)=>e.productId)).size>=2||new Set(claim.evidence.filter((e)=>!e.isProjectAffiliated).map((e)=>e.authorId)).size>=3);
  return {
    dataCutoffAt: input.dataCutoffAt.toISOString(), facts: input.facts,
    platformSummary: supportedClaims.length ? supportedClaims.map((claim)=>claim.text).join("；").slice(0,200) : null,
    items: input.candidates.slice(0, 10).map((item) => ({ ...item, representativePosts: item.representativePosts.slice(0, 2) })),
    evaluationProductIds: input.evaluationProductIds, baselineProductIds: input.baselineProductIds,
  };
}
```

```ts
// src/analysis/representative-posts.ts
const priority: Record<string, number> = { real_usage: 0, independent_analysis: 1, project_launch: 2, news_repost: 3 };
export function representativePosts<T extends { category: string; engagement: number; createdAt: Date }>(posts: readonly T[]): T[] {
  return [...posts].sort((a, b) => (priority[a.category] ?? 4) - (priority[b.category] ?? 4) || b.engagement - a.engagement || b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 2);
}
```

Every model-generated summary claim must carry its evidence tuples `(product_id,author_id,is_project_affiliated)`; unsupported claims are discarded individually before concatenation. Project-affiliated authors never count toward the three-independent-author path. `product-report.ts` uses the same fact structures for `product_analysis` and `realtime_observation`. `markdown-renderer.ts` renders the cutoff, counts, coverage, supported summary, and each item's fixed sections with capture time, ranks, scores, URLs, model labels, and fact-based risks; it never implies star fraud.

- [x] **Step 4: Implement idempotent report persistence**

First create `tests/integration/jobs/generate-report.test.ts`. It seeds 12 eligible Products plus X evidence, calls the still-missing `generateReport`, and asserts Top 10, two representative X links, cutoff-only facts, one idempotent output after two calls, and `partial` when X is unavailable. It then writes `structured_content.evaluation`, mutates current source rows, reruns the same historical cutoff, and asserts byte-identical frozen cutoff facts and Evaluation.

```ts
import { generateReport } from "../../../src/jobs/generate-report.js";
it("persists one replayable Top 10 and preserves an existing evaluation", async () => {
  await seedTwelveEligibleProductsWithEvidence(); const first=await generateReport(reportDeps(),cutoff);
  expect(first.items).toHaveLength(10); expect(first.items.every((x)=>x.representativePosts.length<=2)).toBe(true);
  await attachEvaluation(first.id,{status:"evaluated",evaluated_at:"2026-07-19T00:00:00Z"});
  await generateReport(reportDeps({xUnavailable:true}),cutoff);
  expect(await reportRowCount(cutoff)).toBe(1); expect((await storedReport(cutoff)).structured_content.evaluation).toEqual({status:"evaluated",evaluated_at:"2026-07-19T00:00:00Z"});
});
```

Before implementation run: `ACE_TEST_DATABASE_URL=$ACE_TEST_DATABASE_URL npm test -- --run tests/integration/jobs/generate-report.test.ts`.

Expected: RED with missing `generate-report.ts`.

```ts
// src/jobs/generate-report.ts
import type { Pool } from "pg";
import type { DailyReport } from "../reports/daily-report.js";
export async function persistDailyReport(pool: Pool, report: DailyReport, markdown: string, start: Date, end: Date): Promise<string> {
  const result = await pool.query<{ id: string }>(`insert into ace_hunter.analysis_outputs(output_type,period_start,period_end,data_cutoff_at,status,title,summary,structured_content,rendered_markdown,analysis_version,trigger_type,started_at,completed_at)
    values('daily_report',$1,$2,$3,'complete','今日值得关注',$4,$5,$6,'report-v1','schedule',now(),now())
    on conflict(output_type,period_start,period_end) where output_type='daily_report' and user_id is null and product_id is null
    do update set data_cutoff_at=excluded.data_cutoff_at,status=excluded.status,summary=excluded.summary,
      structured_content=case when ace_hunter.analysis_outputs.structured_content ? 'evaluation' then excluded.structured_content || jsonb_build_object('evaluation',ace_hunter.analysis_outputs.structured_content->'evaluation') else excluded.structured_content end,
      rendered_markdown=excluded.rendered_markdown,completed_at=now() returning id`, [start,end,report.dataCutoffAt,report.platformSummary,JSON.stringify(report),markdown]);
  return result.rows[0].id;
}
```

`generateReport` fixes the cutoff at 08:00 Asia/Shanghai and freezes the complete cutoff input. Before implementing persistence, run `tests/integration/jobs/generate-report.test.ts` RED and expect missing `generate-report.ts`. The test generates a report, attaches a closed-cohort `evaluation`, reruns the daily upsert, and asserts one row with byte-identical cutoff facts and evaluation, Top 10, and two-link limits. Newer source observations belong to a later report and must never rewrite a historical cutoff.

- [x] **Step 5: Run GREEN report checks**

Run: `ACE_TEST_DATABASE_URL=$ACE_TEST_DATABASE_URL npm test -- --run tests/unit/reports tests/integration/jobs/generate-report.test.ts && npm run typecheck && npm run lint`

Expected: PASS for Top 10, two-link limit, evidence threshold, X status wording, model labels, risk wording, score visibility, replay equality, and database idempotency.

Actual: report modules were introduced only after the missing-module RED run. Twelve focused unit/integration tests pass against a real runtime-role PostgreSQL connection. Generation accepts only the canonical 08:00 Asia/Shanghai cutoff, freezes candidate facts and evidence, stores replayable Markdown, upserts one daily row, and preserves both historical output and a previously attached closed-cohort `evaluation` byte-for-byte on rerun. Independent review also led to evidence-tuple verification, actual snapshot capture timestamps, current Trending ranks, cutoff-snapshotted metadata, and suppression of contradictory historical links when X is unavailable.

- [x] **Step 6: Commit Task 9**

```bash
git add src/analysis/representative-posts.ts src/reports src/jobs/generate-report.ts tests/unit/reports tests/integration/jobs/generate-report.test.ts
git commit -m "feat: generate replayable daily reports"
```

### Task 10: Product resolution, observation, monitor commands, and Codex Skill

**Files:**
- Create: `src/products/resolve-product.ts`
- Create: `src/products/analyze-product.ts`
- Create: `src/products/observe-product.ts`
- Create: `src/products/monitor-product.ts`
- Create: `src/cli/output.ts`
- Create: `src/cli/commands/today.ts`
- Create: `src/cli/commands/analyze.ts`
- Create: `src/cli/commands/observe.ts`
- Create: `src/cli/commands/follow.ts`
- Create: `src/cli/commands/monitors.ts`
- Create: `src/cli/commands/jobs.ts`
- Modify: `src/cli/index.ts`
- Create through Skill Creator: `skills/ace-hunter/SKILL.md`
- Create through Skill Creator: `skills/ace-hunter/agents/openai.yaml`
- Test: `tests/unit/products/resolve-product.test.ts`
- Test: `tests/unit/products/observe-product.test.ts`
- Test: `tests/integration/cli/commands.test.ts`

- [x] **Step 1: Write failing resolver and deadline tests with concrete fakes**

```ts
// tests/unit/products/resolve-product.test.ts
import { expect, it } from "vitest";
import { resolveProduct, type ResolverStore } from "../../../src/products/resolve-product.js";
const store: ResolverStore = {
  byGithubFullName: async () => [],
  byName: async (name) => name === "Open" ? [{ id: "a", name }, { id: "b", name }] : [],
};
it("returns candidates instead of guessing an ambiguous name", async () => {
  expect(await resolveProduct(store, "Open")).toEqual({ kind: "ambiguous", candidates: [{ id: "a", name: "Open" }, { id: "b", name: "Open" }] });
});
```

```ts
// tests/unit/products/observe-product.test.ts
import { expect, it } from "vitest";
import { observeProduct } from "../../../src/products/observe-product.js";
it("returns only after children close and clears the deadline timer", async () => {
  let killed = false, closed = false, killCalls = 0; const started = Date.now();
  const deps = {
    latestFreshness: async () => ({ githubAt: null, xAt: null }),
    refreshGithub: async () => ({ stars: 100 }),
    collectX: async () => new Promise<never>(() => undefined),
    analyzeX: async () => ({ analyzed: true }),
    killActiveChildren: async () => { killCalls += 1; killed = true; await new Promise((resolve) => setTimeout(resolve, 5)); closed = true; },
    persist: async () => "observation-id",
    enqueueComments: async () => undefined,
  };
  const result = await observeProduct(deps, "product-id", { deadlineMs: 20, now: new Date("2026-07-19T00:00:00Z") });
  expect(result.status).toBe("partial");
  expect(result.completedSources).toContain("github");
  expect(result.missingSources).toContain("x");
  expect(killed).toBe(true);
  expect(closed).toBe(true);
  expect(Date.now() - started).toBeLessThan(100);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(killCalls).toBe(1);
});

it("collects then analyzes stale X before returning it complete", async () => {
  const order: string[] = [];
  await observeProduct({ latestFreshness: async () => ({ githubAt: new Date(), xAt: null }), refreshGithub: async () => ({}), collectX: async () => { order.push("collect"); return ["post"]; }, analyzeX: async () => { order.push("analyze"); return ["analysis"]; }, killActiveChildren: async () => undefined, persist: async () => "id", enqueueComments: async () => undefined }, "p", { deadlineMs: 100, now: new Date() });
  expect(order).toEqual(["collect", "analyze"]);
});
```

- [x] **Step 2: Run the RED Product tests**

Before running RED, create `tests/integration/cli/commands.test.ts`. Invoke the Commander program in-process with captured stdout/stderr and a real runtime Pool; assert `today`, `analyze`, `observe`, `follow`, `list`, and `unfollow`; assert an unseen GitHub URL creates exactly one Product on retry; assert an unseen plain name remains not-found; assert ambiguity exits 2 with candidates; and assert Follow/List/Unfollow mutate only the monitor row plus sanitized audit Job Runs. Import the still-missing `createProgram` command factory so the suite fails on the missing production boundary, not on absent test files.

```ts
import { createProgram } from "../../../src/cli/index.js";
it("executes every Skill command and keeps unseen URL creation idempotent", async () => {
  const cli=createProgram(cliDependencies(globalThis.testPool));
  for(const argv of [["today"],["analyze","owner/repo"],["observe","owner/repo"],["follow","owner/repo"],["list"],["unfollow","owner/repo"]]) expect((await invoke(cli,argv)).exitCode).toBe(0);
  await invoke(cli,["analyze","https://github.com/new/repo"]); await invoke(cli,["analyze","https://github.com/new/repo"]);
  expect(await productCountFor("new/repo")).toBe(1); expect((await invoke(cli,["analyze","unknown plain name"])).kind).toBe("not_found");
});
```

Run: `ACE_TEST_DATABASE_URL=$ACE_TEST_DATABASE_URL npm test -- --run tests/unit/products tests/integration/cli/commands.test.ts`

Expected: RED with missing Product modules and missing registered CLI command handlers; the integration CLI suite must fail before command implementation.

- [x] **Step 3: Implement product resolution and fresh-on-request orchestration**

```ts
// src/products/resolve-product.ts
export interface Candidate { id: string; name: string; }
export interface ResolverStore { byGithubFullName(value: string): Promise<Candidate[]>; byName(value: string): Promise<Candidate[]>; }
export type Resolution = { kind: "found"; productId: string } | { kind: "ambiguous"; candidates: Candidate[] } | { kind: "not_found" };
export async function resolveProduct(store: ResolverStore, input: string): Promise<Resolution> {
  const match = input.trim().match(/^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
  const rows = match ? await store.byGithubFullName(match[1]) : await store.byName(input.trim());
  return rows.length === 0 ? { kind: "not_found" } : rows.length === 1 ? { kind: "found", productId: rows[0].id } : { kind: "ambiguous", candidates: rows };
}
```

```ts
// src/products/observe-product.ts
export interface ObserveDependencies {
  latestFreshness(productId: string): Promise<{ githubAt: Date | null; xAt: Date | null }>;
  refreshGithub(productId: string, signal: AbortSignal): Promise<unknown>;
  collectX(productId: string, signal: AbortSignal): Promise<unknown>;
  analyzeX(productId: string, collected: unknown, signal: AbortSignal): Promise<unknown>;
  killActiveChildren(): Promise<void>;
  persist(value: unknown): Promise<string>;
  enqueueComments(productId: string): Promise<void>;
}
export async function observeProduct(deps: ObserveDependencies, productId: string, options: { deadlineMs: number; now: Date }) {
  const controller = new AbortController(); let timedOut = false; let timer: NodeJS.Timeout | undefined;
  const freshness = await deps.latestFreshness(productId);
  const githubFresh = freshness.githubAt !== null && options.now.getTime() - freshness.githubAt.getTime() <= 300_000;
  const xFresh = freshness.xAt !== null && options.now.getTime() - freshness.xAt.getTime() <= 900_000;
  const completedSources: string[] = [], missingSources: string[] = [];
  const run = async (name: string, work: () => Promise<unknown>) => { try { const value = await work(); completedSources.push(name); return value; } catch { missingSources.push(name); return null; } };
  const work = Promise.all([run("github", () => githubFresh ? Promise.resolve({ fresh: true }) : deps.refreshGithub(productId, controller.signal)), run("x", async () => { if (xFresh) return { fresh: true }; const collected = await deps.collectX(productId, controller.signal); return deps.analyzeX(productId,collected,controller.signal); })]);
  const deadline = new Promise<[null,null]>((resolve) => { timer = setTimeout(async () => { timedOut = true; controller.abort(new Error("deadline")); await deps.killActiveChildren(); resolve([null,null]); }, options.deadlineMs); });
  try {
    const [github, x] = await Promise.race([work,deadline]);
    if (timedOut) for (const source of ["github","x"]) if (!completedSources.includes(source) && !missingSources.includes(source)) missingSources.push(source);
    void deps.enqueueComments(productId);
    const value = { productId, status: missingSources.length ? "partial" : "complete", completedSources, missingSources, github, x };
    await deps.persist(value); return value;
  } finally { if (timer) clearTimeout(timer); }
}
```

`analyze-product.ts` reads latest offline facts and persists `product_analysis`. A not-found GitHub URL calls `createProductFromRepo`; a not-found plain name remains unresolved. Every twitter-cli child process registers with an observation-scoped process registry; `killActiveChildren` sends `SIGTERM`, waits for `close`, sends `SIGKILL` after 500ms when needed, and resolves only after every child emitted `close`. The hard deadline race cannot be held by a source that ignores AbortSignal. `monitor-product.ts` only upserts or deactivates `(ACE_HUNTER_USER_ID, product_id)`; it does not add a Repository priority column. The metric scheduler derives priority through an active-monitor join. Analyze/observe are counted from their immutable `analysis_outputs`; follow/unfollow commands additionally write sanitized successful `job_runs` audit events named `user_follow`/`user_unfollow` with user/product IDs and request idempotency, enabling repeat-use measurement without a tenth table.

- [x] **Step 4: Register all CLI commands and their deterministic outputs**

```ts
// registration added to src/cli/index.ts
program.command("today").option("--format <format>", "markdown or json", "markdown").action(runToday);
program.command("analyze <target>").option("--format <format>", "markdown or json", "markdown").action(runAnalyze);
program.command("observe <target>").option("--format <format>", "markdown or json", "markdown").action(runObserve);
program.command("follow <target>").action(runFollow);
program.command("list").action(runListMonitors);
program.command("unfollow <target>").action(runUnfollow);
program.command("job <name>").option("--period <period>").option("--scheduled-for <iso>").option("--cutoff-hour-utc <hour>").option("--max-new <count>","discovery insertion cap").option("--orchestrator-run-id <id>").option("--orchestrator-run-attempt <attempt>").option("--orchestrator-workflow <name>").option("--scheduler <name>").option("--scheduler-run-id <id>").action(runJob);
```

`src/cli/output.ts` serializes machine output with stable JSON keys and renders human output from stored Markdown. Ambiguity exits with code 2 and JSON `{ "kind": "ambiguous", "candidates": [...] }`; source partials exit 0 because they are valid observed results, while configuration/authentication errors exit 1.

`runJob` validates attribution with Zod as an all-or-nothing discriminated union: hosted jobs require a decimal GitHub Run ID of at most 20 digits, attempt in `1..100`, and an allowlisted `--orchestrator-workflow`; local scheduled X jobs require `scheduler='launchd'` and a canonical UUID scheduler run ID. Each input is length-bounded, control characters are rejected, and the two attribution modes cannot be mixed. It copies only these validated values into `JobInput.parameters`; unknown metadata is rejected. `tests/integration/cli/commands.test.ts` executes both valid forms, asserts the exact persisted JSON, and runs incomplete, mixed, overlength, and unknown combinations RED before this registration is implemented.

- [x] **Step 5: Initialize and write the Skill using Skill Creator**

Run:

```bash
python /Users/apulu/.codex/skills/.system/skill-creator/scripts/init_skill.py ace-hunter --path skills --interface display_name="Ace Hunter" --interface short_description="发现、分析和观察有潜力的 GitHub 产品" --interface default_prompt="使用 Ace Hunter 查看今日值得关注的项目。"
```

Expected: creates `skills/ace-hunter/SKILL.md` and `skills/ace-hunter/agents/openai.yaml` without extra README files.

Replace the generated Skill body with this concise routing contract:

```markdown
---
name: ace-hunter
description: Discover today's promising GitHub products, analyze or freshly observe a GitHub repository or product, and manage the user's follow list. Use when the user asks 今日值得关注、分析项目、观察项目、关注项目或查看关注。
---

# Ace Hunter

Use the deployment-managed CLI at `$HOME/Library/Application Support/AceHunter/bin/ace-hunter` as the sole execution interface.

- 今日值得关注：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" today`
- 分析目标：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" analyze <target>`
- 实时观察：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" observe <target>`
- 关注：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" follow <target>`
- 查看关注：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" list`
- 取消关注：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" unfollow <target>`

Preserve facts, source links, cutoff times, model-judgment labels, `partial`, and source-unavailable states. If output is `kind=ambiguous`, show all candidates and ask the user to choose; never guess. Never present missing X data as zero discussion.
```

The Skill fails clearly if the Main release has not been installed. It never relies on an npm link or feature-worktree PATH.

- [x] **Step 6: Validate the Skill and run GREEN use-case checks**

Run:

```bash
python /Users/apulu/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/ace-hunter
ACE_TEST_DATABASE_URL=$ACE_TEST_DATABASE_URL npm test -- --run tests/unit/products tests/integration/cli/commands.test.ts
npm run build
node dist/src/cli/index.js --help
npm link
mkdir -p .e2e/codex-home/skills
ln -sfn "$PWD/skills/ace-hunter" .e2e/codex-home/skills/ace-hunter
CODEX_HOME="$PWD/.e2e/codex-home" ACE_HUNTER_ENV_FILE="$PWD/tests/e2e/fixtures/skill.env" codex exec --skip-git-repo-check "使用 ace-hunter Skill 查看我的关注，只输出命令返回的 JSON" > .e2e/skill-output.json
node -e 'const v=require("./.e2e/skill-output.json");if(!Array.isArray(v.monitors))process.exit(1)'
npm run typecheck
npm run lint
```

Expected: Skill validation reports valid; resolver, hard deadline race, child termination, explicit stale-X collect→analyze, nonblocking Comments, monitor idempotency, follow priority set/reset, ambiguity, unseen URL creation, all commands, and JSON/Markdown output tests PASS. `npm link` exposes the built binary; a real Codex invocation discovers the Skill from the fixed temporary `CODEX_HOME`, executes `ace-hunter list` using the fixed non-secret integration environment file, and emits JSON with `monitors`. CLI help lists today/analyze/observe/follow/list/unfollow/job.

Actual: Product and CLI modules were introduced after their missing-boundary RED runs. The production binary now lazily loads the runtime configuration, uses the real restricted PostgreSQL role, resolves and creates explicit GitHub URLs, persists offline/realtime outputs, mutates monitor state and its audit event atomically, and dispatches every existing scheduled job through `JobRunner`. Forty-plus focused tests include real database commands, coherent realtime cutoff persistence, stale analyzed-X detection, job idempotency, and strict attribution. Skill Creator validation passed, and a fresh authenticated Codex process discovered the Skill from an isolated `CODEX_HOME`, invoked only the fixed deployment path, and returned `{ "monitors": [] }`. No npm link was used because the accepted deployment contract forbids development PATH fallback.

- [x] **Step 7: Commit Task 10**

```bash
git add src/products src/cli skills/ace-hunter tests/unit/products tests/integration/cli
git commit -m "feat: expose ace hunter workflows as a codex skill"
```

### Task 11: Scheduler, retention operations, and CI workflows

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/discover.yml`
- Create: `.github/workflows/trending.yml`
- Create: `.github/workflows/refresh-metrics.yml`
- Create: `.github/workflows/collect-x.yml`
- Create: `.github/workflows/daily-report.yml`
- Create: `.github/workflows/retention.yml`
- Create: `.github/workflows/evaluate-success.yml`
- Create: `ops/launchd/com.kevinyoung.ace-hunter.collect-x.plist`
- Create: `ops/launchd/install.sh`
- Create: `ops/launchd/deploy-main.sh`
- Create: `ops/launchd/keychain-secret.swift`
- Create: `scripts/run-scheduled-x.sh`
- Create: `scripts/run-user-command.sh`
- Create: `scripts/validate-skill.mjs`
- Create: `src/jobs/evaluate-success.ts`
- Modify: `src/jobs/retention.ts`
- Test: `tests/unit/operations/schedules.test.ts`
- Test: `tests/integration/operations/repository-limit.test.ts`
- Test: `tests/integration/jobs/evaluate-success.test.ts`
- Modify: `package.json`

- [x] **Step 1: Write failing schedule and repository-capacity tests**

```ts
// tests/unit/operations/schedules.test.ts
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
it("schedules the daily report for 08:30 Asia/Shanghai with an 08:00 cutoff", async () => {
  const yaml = await readFile(".github/workflows/daily-report.yml", "utf8");
  expect(yaml).toContain("cron: '30 0 * * *'");
  expect(yaml).toContain("--cutoff-hour-utc 0");
  expect(yaml).toContain("workflow_dispatch:");
  expect(yaml).toContain("permissions:\n  contents: read");
  expect(yaml).toContain("timeout-minutes:");
  expect(yaml).toContain("concurrency:");
});
it("schedules retention and closed-cohort evaluation with safety controls", async () => {
  for (const file of ["retention.yml", "evaluate-success.yml"]) {
    const yaml = await readFile(`.github/workflows/${file}`, "utf8");
    expect(yaml).toContain("workflow_dispatch:");
    expect(yaml).toContain("permissions:");
    expect(yaml).toContain("contents: read");
    expect(yaml).toContain("timeout-minutes:");
    expect(yaml).toContain("concurrency:");
  }
});
it("gives X a durable six-hour local scheduler instead of requiring an online Actions runner", async () => {
  const plist=await readFile("ops/launchd/com.kevinyoung.ace-hunter.collect-x.plist","utf8");
  const workflow=await readFile(".github/workflows/collect-x.yml","utf8");
  expect(plist).toContain("<key>StartInterval</key>\n  <integer>21600</integer>");
  expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).not.toContain("schedule:");
});
it("persists hosted and launchd attribution passed through the job CLI", async () => {
  expect((await invokeJob(["--orchestrator-run-id","123","--orchestrator-run-attempt","1","--orchestrator-workflow","discover.yml"])).parameters).toMatchObject({orchestrator_run_id:"123",orchestrator_run_attempt:"1",orchestrator_workflow:"discover.yml"});
  expect((await invokeJob(["--scheduler","launchd","--scheduler-run-id",schedulerUuid])).parameters).toMatchObject({scheduler:"launchd",scheduler_run_id:schedulerUuid});
  await expect(invokeJob(["--orchestrator-run-id","123"])).rejects.toThrow(/incomplete attribution/);
});
```

```ts
// tests/integration/jobs/evaluate-success.test.ts
import { expect, it } from "vitest";
import { evaluateClosedCohorts } from "../../../src/jobs/evaluate-success.js";
it("evaluates only cohorts whose seven-day window has closed", async () => {
  await seedReportCohort(globalThis.testPool, { cutoff: "2026-07-01T00:00:00Z", recommended: ["a","b"], baseline: ["b","c"], firstTrending: { a: "2026-07-03T00:00:00Z", b: null, c: "2026-07-02T00:00:00Z" } });
  await seedReportCohort(globalThis.testPool, { cutoff: "2026-07-18T00:00:00Z", recommended: ["d"], baseline: ["d"], firstTrending: { d: "2026-07-19T00:00:00Z" } });
  const result = await evaluateClosedCohorts(globalThis.testPool, new Date("2026-07-19T00:00:00Z"));
  expect(result).toMatchObject({ cohortCount: 1, attentionPrecision: 0.5, baselinePrecision: 0.5, absolutePointDifference: 0, relativeLift: 0, reportOnTimeRate: 1, githubCoverageRate: 1 });
  expect(result.leadTimeHours).toEqual([48]);
  const report=await globalThis.testPool.query("select structured_content from ace_hunter.analysis_outputs where output_type='daily_report' and period_start='2026-07-01T00:00:00Z'");
  expect(report.rows[0].structured_content.evaluation.attentionPrecision).toBe(0.5);
  expect((await globalThis.testPool.query("select count(*)::int n from ace_hunter.analysis_outputs where output_type not in ('daily_report','product_analysis','realtime_observation')")).rows[0].n).toBe(0);
});

it("records X review and user behavior without inventing clicks", async () => {
  await seedXHumanReview(globalThis.testPool,50,{ relevanceCorrect:46,spamDuplicateCorrect:44 });
  await seedUserEvents(globalThis.testPool,{ analyze:1,observe:1,follow:1,repeatWithin7d:1 });
  const result=await evaluateClosedCohorts(globalThis.testPool,new Date("2026-07-19T00:00:00Z"));
  expect(result.xReview).toMatchObject({ sampleSize:50,relevanceAccuracy:0.92,spamDuplicateAccuracy:0.88 });
  expect(result.userBehavior).toMatchObject({ analyze:1,observe:1,follow:1,repeatWithin7d:1 });
  expect(result.clickThroughRate).toBe("not_measurable_in_v0_1");
});
```

```ts
// tests/integration/operations/repository-limit.test.ts
import { expect, it } from "vitest";
import { repositoryCapacityStatus } from "../../../src/jobs/retention.js";
it("warns at 800 and requires lifecycle review before 1000", () => {
  expect(repositoryCapacityStatus(799)).toBe("ok");
  expect(repositoryCapacityStatus(800)).toBe("warning");
  expect(repositoryCapacityStatus(999)).toBe("review_required");
});
```

- [x] **Step 2: Run the RED operations tests**

Run: `npm test -- --run tests/unit/operations/schedules.test.ts tests/integration/operations/repository-limit.test.ts tests/integration/jobs/evaluate-success.test.ts`

Expected: FAIL because workflow files, `repositoryCapacityStatus`, and `evaluate-success.ts` do not exist.

- [x] **Step 3: Add the capacity gate and exact UTC schedules**

```ts
// addition to src/jobs/retention.ts
export type CapacityStatus = "ok" | "warning" | "review_required";
export function repositoryCapacityStatus(count: number): CapacityStatus {
  if (count >= 950) return "review_required";
  if (count >= 800) return "warning";
  return "ok";
}
```

Use these schedule blocks; include `workflow_dispatch` in every job workflow, while X's durable schedule is the LaunchAgent defined below:

```yaml
# discover.yml
on:
  schedule: [{ cron: '17 */6 * * *' }]
  workflow_dispatch:
# trending.yml
on:
  schedule: [{ cron: '7 */4 * * *' }]
  workflow_dispatch:
# refresh-metrics.yml
on:
  schedule: [{ cron: '23 * * * *' }]
  workflow_dispatch:
# collect-x.yml
on:
  workflow_dispatch:
# daily-report.yml
on:
  schedule: [{ cron: '30 0 * * *' }]
  workflow_dispatch:
# retention.yml
on:
  schedule: [{ cron: '45 2 * * *' }]
  workflow_dispatch:
# evaluate-success.yml
on:
  schedule: [{ cron: '15 3 * * *' }]
  workflow_dispatch:
```

Every workflow declares least permissions, timeout, and concurrency. Every CLI Job invocation passes `--orchestrator-run-id '${{ github.run_id }}' --orchestrator-run-attempt '${{ github.run_attempt }}' --orchestrator-workflow '<file>.yml'`; the Job Runner persists all three strings in `job_runs.parameters`. X runs collect/analyze originals, collect/analyze comments under the same orchestrator identifiers. Retention compacts facts. `evaluate-success.ts` finds closed seven-day cohorts and writes `{status:'evaluated',evaluated_at,source_job_run_id,...metrics}` under each eligible `daily_report.structured_content.evaluation`; it never creates a new output type. On a first deployment with no closed cohort, it updates the newest daily report with `{status:'not_enough_history',evaluated_at,source_job_run_id,oldest_eligible_at}` so the successful no-op is explicit and attributable to this run. It also computes report on-time rate from `generate_report` scheduled/completion timestamps, GitHub coverage from frozen report facts, and 7-day analyze/observe/follow repeat behavior from outputs plus audited command runs. Weekly X review input is a checked JSON file of 50 human-labeled post IDs; validation stores only aggregate relevance and spam/duplicate accuracy plus reviewer/time under the evaluated daily report. Missing sample input is `not_reviewed`, never zero accuracy. Link click-through is explicitly `not_measurable_in_v0_1` because there is no Web redirect/event surface; no synthetic click metric is generated.

The production X schedule is a macOS user `launchd` agent, because an ephemeral Actions Runner cannot serve a future cron after deregistration. `StartInterval=21600` plus `RunAtLoad=true` invokes `run-scheduled-x.sh`. The wrapper acquires an atomic `mkdir` lock and writes PID plus its own immutable wrapper realpath. On contention it strictly parses the PID, verifies through `ps` that the live process has that exact wrapper realpath and current UID, and only then exits as an overlapping run; otherwise it removes the stale lock and retries acquisition once. `EXIT INT TERM` always removes a lock still owned by the current PID. Unit tests cover malformed PID, reboot-stale PID, unrelated reused PID, active same-wrapper PID, and trap cleanup; release acceptance creates a stale lock before Kickstart and proves recovery. `keychain-secret.swift` compiles to a small Security.framework helper: `set <allowlisted-account>` reads the value from stdin and calls `SecItemUpdate/SecItemAdd`, while `get` writes it to stdout; secrets never appear in argv. The wrapper reads exactly four runtime values from fixed macOS Keychain service/account names directly into a validated `0700/0600` temporary dotenv, installs safe cleanup, runs authenticated Twitter preflight and collect/analyze originals/comments with `trigger_type='schedule'`, `--scheduler launchd`, and one generated `--scheduler-run-id` UUID, then deletes the temporary directory. It writes only redacted operational logs.

`deploy-main.sh <main-sha> <validated-live-env>` never points production at a feature worktree. It verifies the SHA exists on `origin/main`, creates an immutable candidate under `${HOME}/Library/Application Support/AceHunter/releases/<main-sha>`, uses `git archive` from that exact commit, runs `npm ci`, tests the build, and records a manifest. Before touching `current`, it uses the validated absolute Node binary plus the candidate's absolute `dist/src/cli/index.js` and the supplied temporary env to run `list`; it validates the candidate Skill directly with both validators and checks every required file/dependency. This candidate precheck never resolves `current` and therefore works on first install and upgrades.

After candidate precheck passes, the deployer records the previous `current` target, real-user Skill link, and stable CLI wrapper bytes/mode/owner—or an explicit absence marker for each—inside its owner-only transaction directory. It atomically switches `current` to the candidate and atomically installs `${HOME}/Library/Application Support/AceHunter/bin/ace-hunter`, a mode-0755 wrapper that uses the validated absolute Node path to run `current/scripts/run-user-command.sh`; that script reconstructs a per-command `0700/0600` runtime dotenv from Keychain, traps cleanup, and `exec`s `current/dist/src/cli/index.js`. It then runs `list` through the ordinary stable wrapper and validates the installed real-user Skill link. A post-switch failure atomically restores all three prior artifacts—`current`, Skill link, and wrapper including mode/owner. On first install it removes only the three artifacts created by this transaction. Tests inject failure after switch for both first install and upgrade, then assert exact absent/byte-identical rollback. No npm link is used in production. Paths under `.config/superpowers/worktrees` and a SHA that is not current remote Main are rejected.

The deployer resolves the real Codex home as `${CODEX_HOME:-$HOME/.codex}` and atomically links `<codex-home>/skills/ace-hunter` to `${HOME}/Library/Application Support/AceHunter/current/skills/ace-hunter`. It may replace only a symlink already targeting the AceHunter deployment tree; a pre-existing regular directory or unrelated link is a hard conflict requiring operator review. Candidate tests happen by absolute candidate paths before the switch; stable wrapper and installed Skill tests happen after the switch with rollback as described above.

`install.sh` accepts only this resolved release/current path. At install time it resolves the exact Node and Twitter CLI binaries with `command -v` plus `realpath`, requires regular executable files owned by either root or the current UID and not group/world-writable, executes Node `--version` and the production Twitter preflight, and writes their non-secret absolute paths to a root/current-user-owned `0600` scheduler config. The Plist's `ProgramArguments[0]` is the immutable release wrapper absolute path; the wrapper invokes the recorded absolute Node path and sets `TWITTER_CLI_PATH` to the recorded absolute Twitter binary, never relying on interactive `PATH`, `npm`, or `npm link`. The installer compiles the Keychain helper, renders no secrets into the Plist, installs into the current user's `gui/$UID` domain, and uses `bootout`/`bootstrap` idempotently. Acceptance asserts the Plist and config owners/modes, both binary realpaths, and that the ProgramArguments realpath contains the captured Main SHA and remains valid after the feature worktree is removed. The runbook assigns the local Mac/user as owner, documents login/uptime and sleep limitations, failed-run recovery, Keychain item rotation/revocation, Twitter session renewal, atomic Main upgrades/rollback to the prior immutable release, old-release cleanup, log inspection, and uninstall.

- [x] **Step 4: Add PostgreSQL 14 CI with all quality gates**

```yaml
# .github/workflows/ci.yml
name: ci
on:
  pull_request:
  push:
    branches: [main]
jobs:
  verify:
    permissions:
      contents: read
    timeout-minutes: 20
    concurrency:
      group: ci-${{ github.ref }}
      cancel-in-progress: true
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:14
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: ace_hunter_test
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U postgres" --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      ACE_TEST_ADMIN_DATABASE_URL: postgres://postgres:postgres@localhost:5432/ace_hunter_test
      ACE_TEST_MIGRATION_DATABASE_URL: postgres://ace_hunter_migrator:test-migrator@localhost:5432/ace_hunter_test
      ACE_TEST_RUNTIME_DATABASE_URL: postgres://ace_hunter_runtime:test-runtime@localhost:5432/ace_hunter_test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: psql "$ACE_TEST_ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/helpers/bootstrap-test-db.sql && psql "$ACE_TEST_ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/helpers/bootstrap-test-db.sql
      - run: echo "ACE_HUNTER_MIGRATION_SHA256=$(shasum -a 256 src/db/migrations/0001_ace_hunter_initial.sql | cut -d' ' -f1)" >> "$GITHUB_ENV"
      - run: ACE_HUNTER_MIGRATION_DATABASE_URL="$ACE_TEST_MIGRATION_DATABASE_URL" npm run db:migrate
      - run: psql "$ACE_TEST_ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -c "alter role ace_hunter_runtime login password 'test-runtime';"
      - run: ACE_TEST_DATABASE_URL="$ACE_TEST_RUNTIME_DATABASE_URL" ACE_TEST_ADMIN_DATABASE_URL="$ACE_TEST_ADMIN_DATABASE_URL" ACE_TEST_MIGRATION_DATABASE_URL="$ACE_TEST_MIGRATION_DATABASE_URL" npm test -- --run
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run build
      - run: npm run skill:validate
```

Create the portable CI validator and set `skill:validate` to `node scripts/validate-skill.mjs skills/ace-hunter`:

```js
// scripts/validate-skill.mjs
import { readFile, access } from "node:fs/promises";
const directory = process.argv[2];
if (!directory) throw new Error("skill directory is required");
const text = await readFile(`${directory}/SKILL.md`, "utf8");
const match = text.match(/^---\n([\s\S]*?)\n---\n/);
if (!match) throw new Error("SKILL.md frontmatter is missing");
const name = match[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
const description = match[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
if (!name || !/^[a-z0-9-]{1,64}$/.test(name)) throw new Error("skill name is invalid");
if (!description) throw new Error("skill description is missing");
await access(`${directory}/agents/openai.yaml`);
process.stdout.write(`validated ${name}\n`);
```

Add `test:run`, `skill:validate`, `job:retention`, and `e2e:live` scripts to `package.json`. Local Task 10 continues to use Skill Creator's authoritative `quick_validate.py`; this portable check ensures CI cannot silently skip validation.

- [x] **Step 5: Verify workflow behavior and retention tests GREEN**

Run:

```bash
ACE_TEST_DATABASE_URL=$ACE_TEST_DATABASE_URL npm test -- --run tests/unit/operations tests/integration/operations/repository-limit.test.ts tests/integration/jobs/retention.test.ts tests/integration/jobs/evaluate-success.test.ts
npm run skill:validate
npm run typecheck
npm run lint
npm run build
```

Expected: schedule, dispatch, least permissions, timeout, concurrency, UTC cutoff, secret-name, disposable-role bootstrap, 800/950/1000 boundary, 90-day compaction, daily-preservation-before-delete, closed-cohort Precision@10/baseline/Lead Time evaluation, and Skill validation tests PASS; build outputs `dist/src/cli/index.js`.

- [x] **Step 6: Commit Task 11**

```bash
git add .github/workflows ops/launchd scripts/validate-skill.mjs scripts/run-scheduled-x.sh src/jobs/retention.ts src/jobs/evaluate-success.ts tests/unit/operations tests/integration/operations package.json package-lock.json
git commit -m "ci: schedule and verify ace hunter jobs"
```

### Task 12: Real Supabase/GitHub/X/DeepSeek E2E, PR, and merge

**Files:**
- Create: `scripts/supabase-safety-check.ts`
- Create: `scripts/prepare-live-env.ts`
- Create: `scripts/runtime-permission-check.ts`
- Create: `scripts/live-github-smoke.ts`
- Create: `scripts/live-x-smoke.ts`
- Create: `scripts/live-e2e.ts`
- Create: `scripts/post-merge-acceptance.ts`
- Create: `scripts/run-local-live-acceptance.sh`
- Create: `scripts/run-post-merge-release.sh`
- Create: `scripts/continue-post-merge-release.sh`
- Create: `scripts/assert-twitter-preflight.ts`
- Create: `scripts/pipe-env-value.ts`
- Create: `tests/e2e/live-system.test.ts`
- Create: `docs/operations/ace-hunter-runbook.md`
- Create: `ops/self-hosted-runner/launch-ephemeral.sh`
- Create: `ops/self-hosted-runner/actions-runner.lock`
- Modify: `package.json`

- [ ] **Step 1: Write the failing live-output assertion**

```ts
// tests/e2e/live-system.test.ts
import { expect, it } from "vitest";
import { Pool } from "pg";
import { loadRuntimeConfig } from "../../src/config/load-config.js";

it.runIf(process.env.RUN_LIVE_E2E === "1")("stores a fresh real report and observation", async () => {
  const startedAt = new Date(process.env.ACE_E2E_STARTED_AT!);
  const pool = new Pool({ connectionString: loadRuntimeConfig(process.env).runtimeDatabaseUrl });
  const result = await pool.query(`select output_type,status,structured_content,rendered_markdown from ace_hunter.analysis_outputs
    where (output_type='daily_report' and completed_at >= $1) or (output_type='realtime_observation' and created_at >= $1) order by coalesce(completed_at,created_at) desc`, [startedAt]);
  await pool.end();
  expect(new Set(result.rows.map((row) => row.output_type))).toEqual(new Set(["daily_report", "realtime_observation"]));
  expect(result.rows.every((row) => ["complete", "partial"].includes(row.status) && row.rendered_markdown.length > 0)).toBe(true);
  const daily = result.rows.find((row) => row.output_type === "daily_report");
  expect(daily.structured_content.items.length).toBeGreaterThan(0);
  expect(daily.structured_content.items.length).toBeLessThanOrEqual(10);
});
```

- [ ] **Step 2: Run the live assertion RED before executing the system**

Run:

```bash
export ACE_E2E_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RUN_LIVE_E2E=1 npm test -- --run tests/e2e/live-system.test.ts
```

Expected: FAIL because no `daily_report` and `realtime_observation` created after `ACE_E2E_STARTED_AT` exist yet.

- [ ] **Step 3: Implement Supabase Schema fingerprint safety**

`prepare-live-env.ts` is the only program allowed to read the existing configuration file. It parses dotenv data, never shell code, records the administrator catalog baseline before bootstrap, then applies only the exact reviewed role/schema/auth-grant deltas. Credential lifecycle is explicit: `--mode bootstrap` is allowed only when the fixed migration/runtime Keychain accounts do not yet exist, generates both role passwords once, stores their DSNs through the stdin-only Security.framework helper, and refuses to overwrite; `--mode local` and `--mode release` require and reuse those Keychain DSNs and never rotate a role. Bare invocation is rejected. Password rotation is a separate operator procedure that must atomically update database roles, Keychain, and GitHub Environment with rollback; local live acceptance can never rotate production credentials. The program chooses a real existing auth user, calculates the SQL checksum, and writes a temporary `0700/0600` dotenv containing exactly the required live values and fingerprint path. It prints only that pathname.

```ts
// core of scripts/prepare-live-env.ts
const source = parse(await readFile(sourcePath,"utf8"));
const adminUrl = source.ACE_HUNTER_ADMIN_DATABASE_URL ?? source.SUPABASE_DB_URL;
const githubToken = source.ACE_HUNTER_GITHUB_TOKEN ?? source.GITHUB_TOKEN;
const deepseekKey = source.ACE_HUNTER_DEEPSEEK_API_KEY ?? source.DEEPSEEK_API_KEY;
sourceAliasesSchema.parse({ adminUrl,githubToken,deepseekKey,userId:source.ACE_HUNTER_USER_ID });
const admin = new Pool({ connectionString: adminUrl });
const fingerprintPath = await recordAdminCatalog(admin);
await bootstrapFixedRolesAndSchema(admin);
const user = source.ACE_HUNTER_USER_ID
  ? await admin.query("select id from auth.users where id=$1",[source.ACE_HUNTER_USER_ID])
  : await admin.query("select id from auth.users order by created_at,id limit 1");
if (user.rowCount !== 1) throw new Error("existing_auth_user_required");
const {migrationUrl,runtimeUrl}=await fixedRoleCredentials({mode,keychain,admin,adminUrl});
const checksum=createHash("sha256").update(await readFile("src/db/migrations/0001_ace_hunter_initial.sql")).digest("hex");
const directory=await mkdtemp(join(tmpdir(),"ace-hunter-live-")); await chmod(directory,0o700);
const envPath=join(directory,"runtime.env");
await writeFile(envPath,serializeDotenv({ ACE_HUNTER_ADMIN_DATABASE_URL:adminUrl,ACE_HUNTER_MIGRATION_DATABASE_URL:migrationUrl,ACE_HUNTER_RUNTIME_DATABASE_URL:runtimeUrl,ACE_HUNTER_MIGRATION_SHA256:checksum,ACE_HUNTER_USER_ID:user.rows[0].id,ACE_HUNTER_GITHUB_TOKEN:githubToken,ACE_HUNTER_DEEPSEEK_API_KEY:deepseekKey,DEEPSEEK_BASE_URL:"https://api.deepseek.com",DEEPSEEK_MODEL:"deepseek-chat",TWITTER_CLI_PATH:"twitter",ACE_HUNTER_ADMIN_FINGERPRINT_FILE:fingerprintPath }),{ mode:0o600,flag:"wx" });
await admin.end(); process.stdout.write(`${envPath}\n`);
```

`bootstrapFixedRolesAndSchema`, `setFixedRolePassword`, `withCredentials`, and `serializeDotenv` are fully unit-tested: role names come from a fixed allowlist, passwords are quoted by PostgreSQL `format('%L', $1)` rather than string interpolation, URL credentials use the URL API, dotenv values use JSON string quoting, and no secret is logged.

```ts
// scripts/supabase-safety-check.ts
import { createHash } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import { Pool } from "pg";
import { loadAdminConfig } from "../src/config/load-config.js";
function assertCatalogEqualExceptAceRoles(before: Record<string,unknown>, after: Record<string,unknown>, allowed: string[]) {
  const expectedRoleTuples = { ace_hunter_owner: [false,false,false,false,false,false,false], ace_hunter_migrator: [false,false,false,false,true,false,false], ace_hunter_runtime: [false,false,false,false,true,false,false] } as Record<string,boolean[]>;
  const afterRoles=new Map((after.roles as Array<Record<string,unknown>>).map((r)=>[String(r.rolname),r]));
  for(const name of allowed){const r=afterRoles.get(name);if(!r)throw new Error(`missing ace role: ${name}`);const actual=[r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolcanlogin,r.rolreplication,r.rolbypassrls];if(JSON.stringify(actual)!==JSON.stringify(expectedRoleTuples[name]))throw new Error(`invalid ace role: ${name}`);}
  const expectedCatalog=applyExactBootstrapDelta(before,{
    roles: allowed,
    memberships:[{role_name:'ace_hunter_owner',member_name:'ace_hunter_migrator',admin_option:false}],
    schemaGrants:[{schema_name:'auth',grantee:'ace_hunter_owner',privilege:'USAGE'}],
    columnGrants:[{schema_name:'auth',table_name:'users',column_name:'id',grantee:'ace_hunter_owner',privilege:'REFERENCES'}],
  });
  if(JSON.stringify(canonicalize(expectedCatalog))!==JSON.stringify(canonicalize(after)))throw new Error("administrator catalog changed outside exact reviewed bootstrap delta");
}
const pool = new Pool({ connectionString: loadAdminConfig(process.env).adminDatabaseUrl });
const result = await pool.query(`select jsonb_build_object(
  'schemas',(select jsonb_agg(x order by name) from (select nspname name,pg_get_userbyid(nspowner) owner from pg_namespace where nspname not in ('ace_hunter','pg_catalog','information_schema','pg_toast')) x),
  'relations',(select jsonb_agg(x order by schema_name,relation_name) from (select n.nspname schema_name,c.relname relation_name,c.relkind,pg_get_userbyid(c.relowner) owner,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not in ('ace_hunter','pg_catalog','information_schema','pg_toast')) x),
  'columns',(select jsonb_agg(x order by table_schema,table_name,ordinal_position) from (select table_schema,table_name,ordinal_position,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema not in ('ace_hunter','pg_catalog','information_schema')) x),
  'constraints',(select jsonb_agg(x order by schema_name,table_name,name) from (select n.nspname schema_name,c.relname table_name,k.conname name,pg_get_constraintdef(k.oid,true) definition from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname<>'ace_hunter') x),
  'indexes',(select jsonb_agg(x order by schemaname,indexname) from (select schemaname,indexname,indexdef from pg_indexes where schemaname<>'ace_hunter') x),
  'policies',(select jsonb_agg(x order by schemaname,tablename,policyname) from (select * from pg_policies where schemaname<>'ace_hunter') x),
  'routines',(select jsonb_agg(x order by routine_schema,routine_name,specific_name) from (select routine_schema,routine_name,specific_name,routine_type,data_type,external_language from information_schema.routines where routine_schema not in ('ace_hunter','pg_catalog','information_schema')) x),
  'triggers',(select jsonb_agg(x order by trigger_schema,event_object_table,trigger_name) from (select trigger_schema,event_object_table,trigger_name,event_manipulation,action_statement from information_schema.triggers where trigger_schema<>'ace_hunter') x),
  'types',(select jsonb_agg(x order by schema_name,type_name,label) from (select n.nspname schema_name,t.typname type_name,e.enumlabel label from pg_type t join pg_namespace n on n.oid=t.typnamespace left join pg_enum e on e.enumtypid=t.oid where n.nspname not in ('ace_hunter','pg_catalog','information_schema')) x),
  'roles',(select jsonb_agg(x order by rolname) from (select rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls from pg_roles) x),
  'memberships',(select jsonb_agg(x order by role_name,member_name) from (select r.rolname role_name,m.rolname member_name,g.rolname grantor_name,a.admin_option from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member join pg_roles g on g.oid=a.grantor) x)
) catalog`);
await pool.end();
const catalog = result.rows[0].catalog;
const hash = createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
const file = process.argv[3];
if (process.argv[2] === "record") await writeFile(file, JSON.stringify(catalog), { flag: "wx", mode: 0o600 });
else if (process.argv[2] === "verify") {
  const before = JSON.parse(await readFile(file, "utf8"));
  assertCatalogEqualExceptAceRoles(before,catalog,["ace_hunter_owner","ace_hunter_migrator","ace_hunter_runtime"]);
} else throw new Error("usage: record|verify <fingerprint-file>");
process.stdout.write(`${hash}\n`);
```

The full query additionally stores schema, relation, and column grants as sorted structured rows derived from `aclexplode` and `information_schema.column_privileges`; raw ACL text is not selected or regex-normalized. The non-Ace fingerprint deliberately excludes the `ace_hunter` Schema, so `applyExactBootstrapDelta` adds only the two exact Auth grants shown, the owner→migrator membership, and three fixed role rows. A separate invariant queries `pg_namespace` and requires the Ace Schema owner to be exactly `ace_hunter_owner`. Any Owner grant on another Schema/Table/Column, missing expected membership, extra membership, or any deletion/addition in the non-Ace catalog fails a bidirectional comparison.

`assertCatalogEqualExceptAceRoles` performs a bidirectional diff. The only allowed bootstrap deltas are the three exact role tuples, one owner-to-migrator membership, the owner-created Ace schema, and exact auth `USAGE`/`REFERENCES(id)` ACL grants; all other roles, memberships, ACLs, owners, and catalog rows must remain byte-equivalent. Verify all three roles exist after bootstrap. Add `safety:schema` as the administrator-only check.

```ts
// scripts/runtime-permission-check.ts
import { Pool } from "pg";
import { loadRuntimeConfig } from "../src/config/load-config.js";
const pool = new Pool({ connectionString: loadRuntimeConfig(process.env).runtimeDatabaseUrl });
async function denied(sql: string) { try { await pool.query(sql); throw new Error(`unexpectedly allowed: ${sql}`); } catch (error) { if (error instanceof Error && error.message.startsWith("unexpectedly")) throw error; } }
await pool.query("select count(*) from ace_hunter.products");
await pool.query("begin");
await pool.query("insert into ace_hunter.products(name,status) values('permission-probe','active')");
await pool.query("rollback");
await denied("create schema runtime_escape");
await denied("create table public.runtime_escape(id int)");
await denied("select * from auth.users");
await denied("alter table ace_hunter.products disable row level security");
await denied("set role ace_hunter_migrator");
await pool.end();
process.stdout.write("runtime permission matrix passed\n");
```

Add `safety:runtime` to run this file. It proves allowed Ace Hunter read/write in a rolled-back transaction and denied schema creation, public-table creation, `auth.users` read, RLS alteration, and migration-role escalation.

- [ ] **Step 4: Implement live GitHub, twitter-cli, and DeepSeek smoke checks**

```ts
// scripts/live-x-smoke.ts
import { TwitterCliSource } from "../src/sources/x/twitter-cli-source.js";
import { loadRuntimeConfig } from "../src/config/load-config.js";
const config=loadRuntimeConfig(process.env), source=new TwitterCliSource(config.twitterCliPath);
await source.assertAuthenticated();
const result=await source.searchPosts({ query:process.env.E2E_X_REPO_QUERY ?? '"https://github.com/xai-org/grok-build"',since:new Date(Date.now()-7*86_400_000),until:new Date(),limit:5 });
if (result.length===0) throw new Error("fixture_unavailable: search empty");
const rootId=process.env.E2E_X_ROOT_TWEET_ID ?? "2078468415967367298";
const conversation=await source.searchReplies(rootId,new Date(Date.now()-30*86_400_000),20);
if (!conversation.some((post)=>post.id===rootId||post.rootPostId===rootId)) throw new Error("fixture_unavailable: root missing");
const article=await source.getArticle(process.env.E2E_X_ARTICLE_TWEET_ID ?? "2078268943345803407");
if (!article.articleText.trim()) throw new Error("fixture_unavailable: articleText empty");
process.stdout.write("twitter-cli authenticated search passed\n");
```

`live-github-smoke.ts` calls `/rate_limit`, fetches `ACE_E2E_REPOSITORY`, and invokes all three live Trending collections; it fails if any collection stores zero rows. It compares one stored Stars/Forks pair with a direct GitHub response. `live-x-smoke.ts` requires authenticated `status` plus the replaceable environment defaults above, validates envelope/version/nonempty data, passes at least one returned post through `ModelContentAnalyzer`, and verifies `DEEPSEEK_MODEL` is stored. A disappeared public fixture is `fixture_unavailable` and blocks release until a newly manually verified public ID replaces it; mock data is forbidden. Scripts print counts and public IDs only, never raw content, session data, tokens, or database URLs.

- [ ] **Step 5: Implement the one-command live orchestration**

```ts
// scripts/live-e2e.ts
import { spawn } from "node:child_process";
function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/src/cli/index.js", ...args], { stdio: "inherit", env: process.env, shell: false });
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`ace-hunter ${args.join(" ")} exited ${code}`)));
  });
}
await run(["job", "discover_github_candidates", "--max-new", "3"]);
for (const period of ["daily", "weekly", "monthly"]) await run(["job", "collect_github_trending", "--period", period]);
await run(["job", "refresh_repo_metrics"]);
await run(["job", "collect_x_posts"]);
await run(["job", "analyze_x_posts"]);
await run(["job", "collect_x_comments"]);
await run(["job", "generate_report", "--cutoff-hour-utc", "0"]);
const target = process.env.ACE_E2E_REPOSITORY ?? "openai/openai-node";
await run(["today", "--format", "json"]);
await run(["analyze", target, "--format", "json"]);
await run(["observe", target, "--format", "json"]);
await run(["follow", target]);
await run(["list"]);
await run(["unfollow", target]);
```

Set `e2e:live` to `node --import tsx scripts/live-e2e.ts`, `smoke:github` to the GitHub script, and `smoke:x` to the X/DeepSeek script. The runbook documents only environment variable names, least-privilege `ace_hunter` role grants, local PostgreSQL 14 commands, scheduler ownership, four X statuses, partial-job response, forward-only corrective migration, and secret rotation.

- [ ] **Step 6: Run the complete local regression**

Run:

```bash
ACE_TEST_DATABASE_URL=$ACE_TEST_DATABASE_URL npm test -- --run
npm run typecheck
npm run lint
npm run build
npm run skill:validate
python /Users/apulu/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/ace-hunter
```

Expected: every unit, local PostgreSQL 14 integration, contract, CLI, migration, ranking, report, retention, and non-live E2E test PASS; typecheck/lint/build exit 0; both Skill validators pass; `dist/src/cli/index.js` exists.

- [ ] **Step 7: Implement one-process live acceptance with verified secret cleanup**

`scripts/run-local-live-acceptance.sh` is the only local release entry point. It first compiles `keychain-secret.swift` into `${HOME}/Library/Application Support/AceHunter/bin/ace-hunter-keychain`, verifies its owner/mode/signature inputs, and uses that stable absolute helper for credential bootstrap/retrieval. In one shell process it calls `prepare-live-env.ts`, validates the returned absolute path with `realpath` against `${TMPDIR:-/tmp}/ace-hunter-live-[A-Za-z0-9._-]*/runtime.env`, verifies current ownership and exact directory/file modes `0700/0600`, and only then installs an `EXIT INT TERM` trap. Cleanup repeats those validations before deleting the one matching directory and clears all three traps after explicit deletion. It then reads the fingerprint pathname with strict dotenv parsing and runs migration, Schema/runtime safety, live GitHub, live X/DeepSeek, the full CLI E2E, and the live Vitest assertion. Neither `live_env` nor its lifetime crosses a Run block.

- [ ] **Step 8: Run GREEN real Supabase, GitHub, X, DeepSeek, report, and observation E2E**

Run exactly one command; never source either configuration file:

```bash
scripts/run-local-live-acceptance.sh /Users/apulu/Documents/yy-home/yy-script-creating/.env.local --bootstrap-if-missing
```

The script internally executes:

```bash
export ACE_E2E_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ACE_HUNTER_ENV_FILE="$live_env" npm run db:migrate
ACE_HUNTER_ENV_FILE="$live_env" npm run safety:schema -- verify "$fingerprint_file"
ACE_HUNTER_ENV_FILE="$live_env" npm run safety:runtime
ACE_HUNTER_ENV_FILE="$live_env" npm run smoke:github -- --max-new 3
ACE_HUNTER_ENV_FILE="$live_env" npm run smoke:x
ACE_HUNTER_ENV_FILE="$live_env" npm run e2e:live -- --max-new 3
ACE_HUNTER_ENV_FILE="$live_env" RUN_LIVE_E2E=1 npm test -- --run tests/e2e/live-system.test.ts
```

Expected: bootstrap chooses and verifies one existing auth user; migration succeeds through the migrator DSN; complete administrator catalogs differ only by exact reviewed deltas; exactly nine tables exist; no `schema_migrations` exists; and runtime permissions pass. The secret directory is absent after success, failure, or signal. If a safety check fails, stop and apply only a reviewed forward correction.

Expected:

- GitHub discovery creates a real Product, Primary Repo, and snapshot; live daily/weekly/monthly Trending are nonempty.
- Core and Aux timestamps show their actual capture times; a direct GitHub comparison matches.
- `twitter status --json` proves an authenticated twitter-cli 0.8.5 session; the default repository query, root Tweet ID, and Article Tweet ID pass envelope/version/nonempty/root/articleText assertions; search saves accessible canonical X URLs.
- DeepSeek returns schema-valid classification with nonempty `model_name` and `analysis_version` linked to the X post.
- A real Top 10 report and fresh observation are persisted after `ACE_E2E_STARTED_AT`; all today/analyze/observe/follow/list/unfollow commands exit 0.
- Recomputing one report item from stored facts matches its stored component and total scores within `0.000001`.

Missing twitter authentication, insufficient search/reply capability, missing DeepSeek access, or insufficient Supabase/GitHub permissions fails release acceptance. Fixture data cannot replace any live assertion.

- [ ] **Step 9: Configure protected secrets and an ephemeral X runner**

```bash
# ops/self-hosted-runner/launch-ephemeral.sh
set -euo pipefail
: "${GH_REPO:?GH_REPO owner/name is required}"
: "${1:?main sha required}"
main_sha=$1
repo_root=$(git rev-parse --show-toplevel)
RUNNER_VERSION=$(awk -F= '$1=="version"{print $2}' "$repo_root/ops/self-hosted-runner/actions-runner.lock")
RUNNER_SHA256=$(awk -F= '$1=="osx_arm64_sha256"{print $2}' "$repo_root/ops/self-hosted-runner/actions-runner.lock")
test -n "$RUNNER_VERSION" && test ${#RUNNER_SHA256} -eq 64
runner_dir=$(mktemp -d)
runner_name="ace-hunter-ephemeral-$(date +%s)"
cleanup(){ test -n "${runner_pid:-}" && kill "$runner_pid" 2>/dev/null || true; test -n "${runner_id:-}" && gh api --method DELETE "repos/$GH_REPO/actions/runners/$runner_id" >/dev/null 2>&1 || true; rm -rf "$runner_dir"; }
trap cleanup EXIT INT TERM
archive="$runner_dir/runner.tgz"
curl --fail --location --proto '=https' --tlsv1.2 "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-osx-arm64-${RUNNER_VERSION}.tar.gz" -o "$archive"
printf '%s  %s\n' "$RUNNER_SHA256" "$archive" | shasum -a 256 -c -
tar -xzf "$archive" -C "$runner_dir"
token=$(gh api -X POST "repos/$GH_REPO/actions/runners/registration-token" --jq .token)
node --import tsx "$repo_root/scripts/assert-twitter-preflight.ts"
cd "$runner_dir"
./config.sh --url "https://github.com/$GH_REPO" --token "$token" --name "$runner_name" --labels ace-hunter --ephemeral --unattended
runner_id=$(gh api "repos/$GH_REPO/actions/runners" --jq ".runners[]|select(.name==\"$runner_name\")|.id")
./run.sh & runner_pid=$!
for attempt in {1..12}; do status=$(gh api "repos/$GH_REPO/actions/runners" --jq ".runners[]|select(.name==\"$runner_name\")|.status"); test "$status" = online && break; sleep 5; done
test "$status" = online
max_before=$(gh run list --workflow collect-x.yml --branch main --event workflow_dispatch --limit 100 --json databaseId --jq 'map(.databaseId)|max // 0')
dispatch_at=$(date -u +%Y-%m-%dT%H:%M:%SZ); gh workflow run collect-x.yml --ref main
for attempt in {1..12}; do run_id=$(gh run list --workflow collect-x.yml --branch main --event workflow_dispatch --limit 100 --json databaseId,headSha,createdAt --jq "map(select(.headSha==\"$main_sha\" and .createdAt>=\"$dispatch_at\" and .databaseId>$max_before))|max_by(.databaseId)|.databaseId // empty"); test -n "$run_id" && break; sleep 5; done
test -n "$run_id"; gh run watch "$run_id" --exit-status; wait "$runner_pid"; unset runner_pid
test -z "$(gh api "repos/$GH_REPO/actions/runners" --jq ".runners[]|select(.name==\"$runner_name\")|.name")"
```

Create the protected GitHub Environment `ace-hunter-production` with deployment branch restriction to `main`, without approval gates or a wait timer, so post-merge jobs remain unattended. Set `ACE_HUNTER_RUNTIME_DATABASE_URL`, `ACE_HUNTER_GITHUB_TOKEN`, `ACE_HUNTER_USER_ID`, and `ACE_HUNTER_DEEPSEEK_API_KEY` interactively with `gh secret set <name> --env ace-hunter-production`; verify names only with `gh secret list --env ace-hunter-production`. Never upload the migration URL, twitter cookies, env file, or runner registration token. `collect-x.yml` uses `runs-on: [self-hosted, ace-hunter]`, `environment: ace-hunter-production`, and the ephemeral runner above; the host's already authenticated twitter-cli session remains local. All production job workflows use the protected environment and only the runtime database URL.

Make the setup executable and repeatable: `gh api --method PUT repos/kevinyoung11/ace-hunter/environments/ace-hunter-production` creates/updates the Environment; the deployment-branch-policy endpoint is reconciled to exactly `main`; a follow-up GET asserts no reviewer and no wait timer. `scripts/pipe-env-value.ts <path> <allowlisted-key>` strictly parses dotenv, refuses every key outside the four runtime secret names, and writes only the selected value to stdout. Both initial setup and `run-post-merge-release.sh` reconcile all four secrets from the freshly prepared live file with `node --import tsx scripts/pipe-env-value.ts "$live_env" NAME | gh secret set NAME --env ace-hunter-production`; no value appears in arguments or logs. Reconciliation happens before any Workflow dispatch and normally preserves the stable Keychain-backed Runtime DSN. Verify only the four names with `gh secret list --env ace-hunter-production --json name --jq 'map(.name)|sort'`.

During Task 12, pin one official `actions/runner` release tag. Read that exact tag's Release body through the official GitHub API, extract the SHA-256 line bound to the exact `actions-runner-osx-arm64-<version>.tar.gz` asset name, download that asset, and locally verify it before committing only `version=<exact>` plus `osx_arm64_sha256=<64 hex>` to `actions-runner.lock`. Do not assume a checksum-manifest asset exists. The launcher refuses missing/malformed lock data, downloads only that matching official release URL, verifies SHA before extraction, starts in background, polls online state, dispatches only after online, watches the timestamp-and-database-ID-selected run, waits for the runner PID to exit, proves deregistration, and cleans files through its trap. `assert-twitter-preflight.ts` reuses the production `TwitterCliSource.assertAuthenticated()` parser, including exact binary `0.8.5` and `data.authenticated===true`; shell code does not implement a weaker parser.

- [ ] **Step 10: Commit Task 12**

```bash
git add scripts/prepare-live-env.ts scripts/supabase-safety-check.ts scripts/runtime-permission-check.ts scripts/live-github-smoke.ts scripts/live-x-smoke.ts scripts/live-e2e.ts scripts/post-merge-acceptance.ts scripts/run-local-live-acceptance.sh scripts/run-post-merge-release.sh scripts/continue-post-merge-release.sh scripts/assert-twitter-preflight.ts scripts/pipe-env-value.ts ops/self-hosted-runner tests/e2e/live-system.test.ts docs/operations/ace-hunter-runbook.md package.json package-lock.json
git commit -m "test: verify ace hunter end to end"
```

- [ ] **Step 11: Push and open the pull request**

Run:

```bash
git status --short
git log --oneline origin/main..HEAD
git push -u origin feature/ace-hunter-v0-1
gh pr create --base main --head feature/ace-hunter-v0-1 --title "feat: ship Ace Hunter V0.1" --body "Implements the confirmed Ace Hunter V0.1 specification with TDD, live source acceptance, and Supabase schema isolation."
```

Expected: worktree is clean before push; PR contains the reviewed implementation and task commits, with no `.env` file, cookie, token, database URL, or unrelated file.

- [ ] **Step 12: Require green PR checks without running production workflows from the PR branch**

Run:

```bash
gh pr checks --watch
gh pr view --json state,headRefOid,statusCheckRollup
```

Expected: required deterministic CI checks are green. Live GitHub/X/DeepSeek/Supabase checks have already run locally in Steps 7–8. No production workflow is dispatched from an unmerged branch, and no protected production Environment is approved for the PR SHA. Correct genuine failures on the same branch and rerun CI; do not disable or bypass checks.

- [ ] **Step 13: Merge, dispatch every workflow on main, and verify exact run IDs**

Run:

```bash
SOURCE_ENV=/Users/apulu/Documents/yy-home/yy-script-creating/.env.local \
GH_REPO=kevinyoung11/ace-hunter \
ACE_E2E_REPOSITORY=openai/openai-node \
scripts/run-post-merge-release.sh
```

`run-post-merge-release.sh` performs the merge and captures the exact Main SHA, PR head SHA, and acceptance start. Before deployment it runs exactly `node --import tsx scripts/prepare-live-env.ts --mode release --source "$SOURCE_ENV"`; release mode requires both fixed Keychain DSNs, reuses them, and fails closed if either is absent—it cannot bootstrap or rotate. The script validates the returned pathname/owner/modes and installs cleanup. It exports each prior runtime Keychain value—or an explicit absent marker—into a separate owner-only `0600` rollback file inside the validated temporary directory, then pipes the four candidate values through the stdin-only helper and reads each back for equality without logging it. Until deployment's post-switch stable-wrapper/Skill smoke passes, the failure trap restores every old value or deletes an account that was previously absent. Only after those prerequisites pass does it call `deploy-main.sh "$main_sha" "$live_env"`, which performs the absolute candidate precheck, atomic switch, and post-switch smoke described above. Any failure leaves/restores the previous release and runtime Keychain state and deletes the temporary directory.

After the deployer's post-switch smoke passes, the caller marks the new Keychain state committed, removes the rollback file, and `exec`s the immutable release's `scripts/continue-post-merge-release.sh` with the validated live-env path, exact old worktree path, PR head SHA, and release metadata. The continuation first revalidates the live-env path/owner/modes and immediately takes over `EXIT INT TERM` cleanup. It verifies the old path is the registered clean `feature/ace-hunter-v0-1` worktree at the recorded PR head and that this head is an ancestor of the merged Main SHA, changes into the persistent release, and removes only that exact worktree through the main repository's `git worktree remove`; it uses no broad path and no force flag. Every later command therefore executes from immutable Main, not from the feature worktree. It never calls `prepare-live-env.ts` again or reuses state from Step 8.

The continuation watches exact-SHA CI, launches and waits for the ephemeral X Runner, and dispatches each remaining Workflow after recording both dispatch time and prior maximum database ID. For every watched run it records `{workflow,databaseId,runAttempt}` in a fresh non-secret acceptance JSON file; this file shares the validated temporary directory and cleanup.

With Keychain already reconciled and verified before deployment, it runs the idempotent LaunchAgent installer against the immutable release, records the database clock boundary immediately before Kickstart, creates a stale-lock fixture, invokes `launchctl kickstart -k gui/$UID/com.kevinyoung.ace-hunter.collect-x`, and selects the first later `collect_x_posts` Job as the Kickstart `scheduler_run_id`. Only rows with that exact ID count. The three Job Runs—collect originals, analyze originals, and collect-plus-analyze comments—must succeed/partial under that shared ID; the comments Job freezes `product_ids` and `root_post_ids` in parameters, and persisted Comment analysis must match those IDs and the Job's own start/completion interval. This proves all four X processing stages through the durable scheduler independently of the release-only ephemeral Runner and after feature-worktree removal.

After the workflows it runs the deployment-managed absolute wrapper `${HOME}/Library/Application Support/AceHunter/bin/ace-hunter observe "$ACE_E2E_REPOSITORY" --format json`, resolves the wrapper's `current/dist` target to the captured Main SHA, and invokes the validated absolute Codex binary with the real user Codex home to ask the installed Ace Hunter Skill for `list` and one `observe`. Both outputs must succeed and the Skill symlink plus executed CLI target must resolve inside the immutable Main release, never the removed worktree. It then calls `post-merge-acceptance.ts` with the JSON path. Finally it explicitly removes the validated secret directory, clears `EXIT INT TERM` traps, fetches Main again, and asserts the SHA is unchanged.

`post-merge-acceptance.ts` uses the runtime DSN and watched run IDs to require successful/partial Job Runs for discovery, metrics, the release-dispatch X pipeline, report, retention, and evaluation. It separately requires the Kickstarted LaunchAgent's newer collect/analyze/comment Job Runs with one shared scheduler ID. Trending must have three rows attributable to the watched dispatch with `parameters.period` exactly Daily, Weekly, and Monthly. It proves the daily-report workflow reran by `completed_at >= ACCEPTANCE_STARTED_AT`, not `created_at`. It proves evaluation ran by `evaluate_success` Job plus an Evaluation whose `evaluated_at` is inside the window and whose `source_job_run_id` matches: status is either `evaluated` on a closed historical Cohort or `not_enough_history` on first deployment. The explicit post-workflow Observe must create a realtime output inside the same window. Expected: exact-SHA CI and every watched run pass, both ephemeral and durable X execution paths persist attributable facts, the Runner deregisters, the LaunchAgent remains loaded, and the freshly prepared secret directory is deleted on success, failure, or signal.

```ts
const required=[['discover_github_candidates','discover.yml'],['collect_github_trending','trending.yml'],['refresh_repo_metrics','refresh-metrics.yml'],['collect_x_posts','collect-x.yml'],['analyze_x_posts','collect-x.yml'],['collect_x_comments','collect-x.yml'],['generate_report','daily-report.yml'],['retention','retention.yml'],['evaluate_success','evaluate-success.yml']] as const;
const expectedRuns=acceptanceRunSchema.parse(JSON.parse(await readFile(process.env.ACCEPTANCE_RUN_IDS_FILE!,"utf8")));
const jobs=await pool.query("select id,job_name,parameters from ace_hunter.job_runs where scheduled_for >= $1 and status in ('success','partial')",[startedAt]);
const belongsToWatchedRun=(row,workflow)=>{const expected=expectedRuns.find((x)=>x.workflow===workflow);return expected && row.parameters.orchestrator_workflow===workflow && row.parameters.orchestrator_run_id===String(expected.databaseId) && row.parameters.orchestrator_run_attempt===String(expected.runAttempt);};
for(const [name,workflow] of required)if(!jobs.rows.some((row)=>row.job_name===name&&belongsToWatchedRun(row,workflow)))throw new Error(`missing_acceptance_job:${name}`);
const trendingPeriods=new Set(jobs.rows.filter((row)=>row.job_name==='collect_github_trending'&&belongsToWatchedRun(row,'trending.yml')).map((row)=>row.parameters.period));
if(JSON.stringify([...trendingPeriods].sort())!==JSON.stringify(['daily','monthly','weekly']))throw new Error('missing_trending_period');
const reports=await pool.query(`select output_type,completed_at,created_at,structured_content from ace_hunter.analysis_outputs where (output_type='daily_report' and completed_at >= $1) or (output_type='realtime_observation' and created_at >= $1)`,[startedAt]);
if(!reports.rows.some((row)=>row.output_type==='daily_report'))throw new Error('daily_report_not_rerun');
if(!reports.rows.some((row)=>row.output_type==='realtime_observation'))throw new Error('missing_realtime_observation');
const evaluation=await pool.query(`select structured_content->'evaluation' value from ace_hunter.analysis_outputs where output_type='daily_report' and (structured_content->'evaluation'->>'evaluated_at')::timestamptz >= $1`,[startedAt]);
const evaluateJob=jobs.rows.find((row)=>row.job_name==='evaluate_success'&&belongsToWatchedRun(row,'evaluate-success.yml'));
if(!evaluateJob || !evaluation.rows.some((row)=>['evaluated','not_enough_history'].includes(row.value.status)&&row.value.source_job_run_id===evaluateJob.id))throw new Error('missing_current_evaluation_status');
const kicked=await pool.query(`select parameters->>'scheduler_run_id' scheduler_run_id from ace_hunter.job_runs where created_at > $1 and job_name='collect_x_posts' and parameters->>'scheduler'='launchd' order by created_at limit 1`,[kickstartBoundary]);
if(kicked.rowCount!==1)throw new Error('kickstarted_x_pipeline_missing');
const schedulerRunId=kicked.rows[0].scheduler_run_id;
const scheduledX=await pool.query(`select job_name,parameters,started_at,completed_at,status from ace_hunter.job_runs where parameters->>'scheduler'='launchd' and parameters->>'scheduler_run_id'=$1`,[schedulerRunId]);
if(!['collect_x_posts','analyze_x_posts','collect_x_comments'].every((name)=>scheduledX.rows.some((row)=>row.job_name===name&&['success','partial'].includes(row.status))))throw new Error('durable_x_pipeline_not_attributable');
const commentsJob=scheduledX.rows.find((row)=>row.job_name==='collect_x_comments');
const analyzedComments=await pool.query(`select count(*)::int n from ace_hunter.product_x_posts where post_type='comment' and product_id=any($1::uuid[]) and root_post_id=any($2::text[]) and analyzed_at between $3 and $4 and relevance_score is not null and sentiment is not null`,[commentsJob.parameters.product_ids,commentsJob.parameters.root_post_ids,commentsJob.started_at,commentsJob.completed_at]);
if(analyzedComments.rows[0].n<1)throw new Error('durable_x_comments_not_analyzed');
const launchd=await execFile('/bin/launchctl',['print',`gui/${process.getuid()}/com.kevinyoung.ace-hunter.collect-x`]);
if(!launchd.stdout.includes(mainSha)||launchd.stdout.includes('.config/superpowers/worktrees'))throw new Error('launchagent_not_bound_to_main_release');
for(const binary of [schedulerConfig.nodePath,schedulerConfig.twitterPath])await assertOwnedExecutableRealpath(binary);
```

## Final completion gate

Completion requires all 12 task commits, full local PostgreSQL 14 regression, identical non-Ace Supabase Schema fingerprints, live GitHub/Trending/twitter-cli/DeepSeek acceptance, a real stored report and observation, successful hosted workflows, an installed and Kickstarted durable X LaunchAgent with attributable persisted results, a merged PR, and green remote `main`. Runtime source outages may produce explicitly marked partial reports, but missing production credentials, local scheduler capability, or provider capability is a release failure.
