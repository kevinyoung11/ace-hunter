# Minimal GitHub Signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship stable Skill-visible GitHub Trending daily/weekly/monthly lists and candidate-v2 potential repositories based only on repository age and Star facts.

**Architecture:** Keep the existing collection jobs and PostgreSQL tables, but narrow the candidate rules and add two independent read models that bypass the current daily report. New Commander commands call those read models through the existing runtime dependency boundary and render deterministic Markdown or JSON; GitHub Actions remains the scheduler.

**Tech Stack:** Node.js 22, TypeScript, Commander, PostgreSQL 14/Supabase, Vitest, GitHub Actions, Codex Skill Markdown.

---

### Task 1: Candidate-v2 rule source of truth

**Files:**
- Modify: `src/sources/github/repository-search.ts`
- Modify: `src/jobs/discover-github-candidates.ts`
- Modify: `src/reports/report-data.ts`
- Modify: `tests/unit/sources/github/repository-search.test.ts`
- Modify: `tests/integration/jobs/discover-github-candidates.test.ts`
- Modify: `tests/integration/reports/report-data.test.ts`

- [ ] **Step 1: Write failing boundary tests**

Add table-driven assertions equivalent to:

```ts
it.each([
  ["2026-07-19T00:00:00.000Z", 10, ["age_1d_stars_10"]],
  ["2026-07-18T00:00:00.000Z", 100, ["age_1d_stars_10", "age_3d_stars_100"]],
  ["2026-07-17T00:00:00.000Z", 100, ["age_3d_stars_100"]],
  ["2026-07-16T00:00:00.000Z", 100, ["age_3d_stars_100"]],
  ["2026-07-15T23:59:59.999Z", 100, []],
])("classifies candidate-v2 boundaries", (createdAt, stars, expected) => {
  expect(candidateBuckets({ createdAt: new Date(createdAt), stars }, at)).toEqual(expected);
});
```

Add discovery assertions that GitHub searches exactly `now-1d stars>=10` and `now-3d stars>=100`, and persists `candidate_rule_version='v2'`. Add report-data assertions proving 3-day candidates are included while 7-day/30-day-only rows are excluded.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
ACE_TEST_RUNTIME_DATABASE_URL=postgres://ace_hunter_runtime:test-runtime@localhost/ace_hunter_test \
ACE_TEST_ADMIN_DATABASE_URL=postgres://localhost/ace_hunter_test \
ACE_TEST_MIGRATION_DATABASE_URL=postgres://ace_hunter_migrator:test-migrator@localhost/ace_hunter_test \
npm test -- --run tests/unit/sources/github/repository-search.test.ts \
  tests/integration/jobs/discover-github-candidates.test.ts \
  tests/integration/reports/report-data.test.ts
```

Expected: failures mention the removed 7-day/30-day buckets, wrong second search slice, `v1`, or missing 3-day report candidate.

- [ ] **Step 3: Implement the minimal candidate-v2 rules**

Make `candidateBuckets` return only:

```ts
return [
  age <= dayMs && repo.stars >= 10 ? "age_1d_stars_10" : null,
  age <= 3 * dayMs && repo.stars >= 100 ? "age_3d_stars_100" : null,
].filter((value): value is string => value !== null);
```

Replace discovery search rules with one-day/10-Star and three-day/100-Star slices, persist version `v2`, and update the report candidate predicate to the same 24h/72h rules.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/sources/github/repository-search.ts src/jobs/discover-github-candidates.ts \
  src/reports/report-data.ts tests/unit/sources/github/repository-search.test.ts \
  tests/integration/jobs/discover-github-candidates.test.ts tests/integration/reports/report-data.test.ts
git commit -m "feat: narrow potential repository rules"
```

### Task 2: Potential repository read model

**Files:**
- Create: `src/reports/potential-list.ts`
- Create: `tests/integration/reports/potential-list.test.ts`
- Create: `tests/unit/reports/potential-list.test.ts`

- [ ] **Step 1: Write failing read-model tests**

Define the desired API in tests:

```ts
const result = await loadPotentialRepositories(pool, {
  now: new Date("2026-07-20T00:00:00Z"),
  rule: "all",
  limit: 20,
});
expect(result).toMatchObject({ kind: "potential_repositories", rule: "all" });
expect(result.items.map((item) => item.fullName)).toEqual(["owner/fast", "owner/steady"]);
expect(result.items[0].matchedRules).toEqual(["1d", "3d"]);
```

Seed exact 24h/72h boundaries, one-millisecond-old exclusions, forks/archives/mirrors, future snapshots and deterministic ties. Add pure renderer assertions for source links, rule labels, timestamps, empty state and newline termination.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
ACE_TEST_RUNTIME_DATABASE_URL=postgres://ace_hunter_runtime:test-runtime@localhost/ace_hunter_test \
ACE_TEST_ADMIN_DATABASE_URL=postgres://localhost/ace_hunter_test \
ACE_TEST_MIGRATION_DATABASE_URL=postgres://ace_hunter_migrator:test-migrator@localhost/ace_hunter_test \
npm test -- --run tests/integration/reports/potential-list.test.ts \
  tests/unit/reports/potential-list.test.ts
```

Expected: module resolution fails because `potential-list.ts` does not exist.

- [ ] **Step 3: Implement query, validation, sorting and Markdown**

Export these contracts:

```ts
export type PotentialRule = "all" | "1d" | "3d";
export type ResultLimit = number | null;
export interface PotentialListOptions { now: Date; rule: PotentialRule; limit: ResultLimit }
export async function loadPotentialRepositories(pool: Pool, options: PotentialListOptions): Promise<PotentialList>;
export function renderPotentialList(value: PotentialList): string;
```

Read each active primary Repository's latest cutoff-safe Snapshot, compute rules and `starsPerHour = stars / Math.max(ageHours, 1)`, filter by rule, then sort by velocity, Stars, creation time and full name. Reject invalid dates, rules, limits, negative/unsafe counts and future-created repositories.

- [ ] **Step 4: Run tests and verify GREEN**

Run the Step 2 command. Expected: both files pass.

- [ ] **Step 5: Commit**

```bash
git add src/reports/potential-list.ts tests/integration/reports/potential-list.test.ts \
  tests/unit/reports/potential-list.test.ts
git commit -m "feat: add potential repository read model"
```

### Task 3: Trending latest-complete read model

**Files:**
- Create: `src/reports/trending-list.ts`
- Create: `tests/integration/reports/trending-list.test.ts`
- Create: `tests/unit/reports/trending-list.test.ts`

- [ ] **Step 1: Write failing complete-batch and renderer tests**

Define the API:

```ts
const result = await loadTrendingLists(pool, {
  now: new Date("2026-07-20T12:00:00Z"),
  period: "all",
  limit: 20,
});
expect(result.lists.map((list) => list.period)).toEqual(["daily", "weekly", "monthly"]);
expect(result.lists[0].items.map((item) => item.rank)).toEqual([1, 2]);
```

Seed a prior complete batch and newer partial batch; assert the complete batch is returned. Cover independent period availability, rank order, integer/all limits, 36-hour exact stale boundary, missing complete period, repository metadata and deterministic Markdown.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
ACE_TEST_RUNTIME_DATABASE_URL=postgres://ace_hunter_runtime:test-runtime@localhost/ace_hunter_test \
ACE_TEST_ADMIN_DATABASE_URL=postgres://localhost/ace_hunter_test \
ACE_TEST_MIGRATION_DATABASE_URL=postgres://ace_hunter_migrator:test-migrator@localhost/ace_hunter_test \
npm test -- --run tests/integration/reports/trending-list.test.ts \
  tests/unit/reports/trending-list.test.ts
```

Expected: module resolution fails because `trending-list.ts` does not exist.

- [ ] **Step 3: Implement latest-complete selection and Markdown**

Export:

```ts
export type TrendingListPeriod = "daily" | "weekly" | "monthly" | "all";
export interface TrendingListOptions { now: Date; period: TrendingListPeriod; limit: number | null }
export async function loadTrendingLists(pool: Pool, options: TrendingListOptions): Promise<TrendingLists>;
export function renderTrendingLists(value: TrendingLists): string;
```

For each requested period, select the greatest `captured_at <= now` whose rows are all successful, join Repository plus its latest cutoff-safe Snapshot for total Stars, order by rank, and apply the per-section limit. Mark stale only when age is strictly greater than 36 hours. Return `kind=not_found` only when none of the requested periods has a complete batch.

- [ ] **Step 4: Run tests and verify GREEN**

Run the Step 2 command. Expected: both files pass.

- [ ] **Step 5: Commit**

```bash
git add src/reports/trending-list.ts tests/integration/reports/trending-list.test.ts \
  tests/unit/reports/trending-list.test.ts
git commit -m "feat: add reliable trending read model"
```

### Task 4: CLI commands and runtime integration

**Files:**
- Create: `src/cli/commands/potential.ts`
- Create: `src/cli/commands/trending.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/cli/runtime-dependencies.ts`
- Modify: `tests/integration/cli/commands.test.ts`
- Modify: `tests/integration/cli/runtime-dependencies.test.ts`

- [ ] **Step 1: Write failing command tests**

Extend the CLI harness with `potential(options)` and `trending(options)`. Assert default calls:

```ts
expect(dependencies.potential).toHaveBeenCalledWith({ rule: "all", limit: 20 });
expect(dependencies.trending).toHaveBeenCalledWith({ period: "daily", limit: 20 });
```

Cover `--limit all`, integer 1/1000, rejection of 0/1001/non-integer, invalid rule/period, Markdown default and stable JSON. Add database-runtime assertions that seeded facts are returned through the actual command path.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
ACE_TEST_RUNTIME_DATABASE_URL=postgres://ace_hunter_runtime:test-runtime@localhost/ace_hunter_test \
ACE_TEST_ADMIN_DATABASE_URL=postgres://localhost/ace_hunter_test \
ACE_TEST_MIGRATION_DATABASE_URL=postgres://ace_hunter_migrator:test-migrator@localhost/ace_hunter_test \
npm test -- --run tests/integration/cli/commands.test.ts \
  tests/integration/cli/runtime-dependencies.test.ts
```

Expected: TypeScript/test failures show missing dependency methods and unregistered commands.

- [ ] **Step 3: Implement commands and dependency wiring**

Register:

```ts
program.command("potential")
  .option("--rule <rule>", "all, 1d, or 3d", "all")
  .option("--limit <limit>", "1-1000 or all", "20")
  .option("--format <format>", "markdown or json", "markdown");

program.command("trending <period>")
  .option("--limit <limit>", "1-1000 or all", "20")
  .option("--format <format>", "markdown or json", "markdown");
```

Use one shared strict limit parser. Production dependencies fix `now` once per invocation, call the read model, and return `{ kind, structuredContent, renderedMarkdown }`.

- [ ] **Step 4: Run tests and verify GREEN**

Run the Step 2 command. Expected: both CLI suites pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/potential.ts src/cli/commands/trending.ts src/cli/index.ts \
  src/cli/runtime-dependencies.ts tests/integration/cli/commands.test.ts \
  tests/integration/cli/runtime-dependencies.test.ts
git commit -m "feat: expose GitHub signal commands"
```

### Task 5: Daily schedule, Skill routes and documentation

**Files:**
- Modify: `.github/workflows/trending.yml`
- Modify: `tests/unit/operations/schedules.test.ts`
- Modify: `skills/ace-hunter/SKILL.md`
- Modify: `skills/ace-hunter/agents/openai.yaml`
- Modify: `docs/superpowers/specs/2026-07-19-ace-hunter-skill-first-design.md`
- Test: `tests/unit/operations/schedules.test.ts`

- [ ] **Step 1: Write failing schedule and Skill assertions**

Change the schedule expectation to `7 0 * * *`. Assert Skill instructions contain the exact deployment-managed commands for all four Trending views and all three potential rule views, preserve source/capture/stale fields, and do not route these requests through `today`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- --run tests/unit/operations/schedules.test.ts
node scripts/validate-skill.mjs skills/ace-hunter
```

Expected: schedule test fails on the existing four-hour cron and Skill assertions fail on missing routes.

- [ ] **Step 3: Apply configuration and documentation changes**

Set:

```yaml
on:
  schedule: [{ cron: '7 0 * * *' }]
```

Document the new CLI routes in the Skill, update the agent default prompt without exceeding manifest limits, and replace the old candidate thresholds in the product specification with candidate-v2.

- [ ] **Step 4: Run tests and verify GREEN**

Run the Step 2 commands. Expected: schedule test and Skill validator pass.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/trending.yml tests/unit/operations/schedules.test.ts \
  skills/ace-hunter/SKILL.md skills/ace-hunter/agents/openai.yaml \
  docs/superpowers/specs/2026-07-19-ace-hunter-skill-first-design.md
git commit -m "feat: schedule and document minimal GitHub signals"
```

### Task 6: Full verification and live acceptance

**Files:**
- Modify only if a failing acceptance test proves a defect in Tasks 1–5.

- [ ] **Step 1: Run the complete local verification matrix**

```bash
ACE_TEST_RUNTIME_DATABASE_URL=postgres://ace_hunter_runtime:test-runtime@localhost/ace_hunter_test \
ACE_TEST_ADMIN_DATABASE_URL=postgres://localhost/ace_hunter_test \
ACE_TEST_MIGRATION_DATABASE_URL=postgres://ace_hunter_migrator:test-migrator@localhost/ace_hunter_test \
npm test -- --run
npm run typecheck
npm run lint
npm run build
npm run skill:validate
git diff --check
```

Expected: all commands exit 0; only opt-in live suites remain skipped.

- [ ] **Step 2: Run read-only production compatibility checks**

Against the existing runtime role, execute the feature build's `trending daily/weekly/monthly/all` and `potential` commands in JSON mode. Verify no Schema migration is needed, every link/capture time matches a direct read-only Supabase query, limits are honored, and no X/model credential is required by these paths.

- [ ] **Step 3: Review, push and open PR**

Review scoped diff/status, push `codex/minimal-github-signals`, open a PR against `main` with behavior and verification evidence, wait for CI, and address failures using systematic debugging.

- [ ] **Step 4: Merge and create the immutable release**

After CI passes, merge the PR with a Merge Commit. Fetch the exact remote main SHA, create and validate the immutable Ace Hunter release, atomically switch `current`, and update the installed Skill link without exposing or rotating credentials.

- [ ] **Step 5: Run real collection and Skill acceptance**

From the final immutable release, invoke each Trending period with a new current scheduled timestamp and invoke discovery with a conservative insertion cap. Verify exact attributed Job Runs, latest complete batches, candidate-v2 provenance and idempotent replay without deleting historical facts. Then use `$ace-hunter` through Codex to request GitHub daily/weekly/monthly lists and potential projects; verify the installed Skill returns source links, rule labels, capture time and stale state faithfully.
