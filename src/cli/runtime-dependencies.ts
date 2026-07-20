import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { Pool } from "pg";
import { Pool as PgPool } from "pg";
import { loadReadonlyRuntimeConfig, loadRuntimeConfig } from "../config/load-config.js";
import { loadedSecretValues } from "../config/schema.js";
import { createHttpTransport } from "../core/http-transport.js";
import { AnalysisOutputStore } from "../db/stores/analysis-output-store.js";
import { SnapshotStore } from "../db/stores/snapshot-store.js";
import { ModelContentAnalyzer } from "../analysis/model-content-analyzer.js";
import { analyzeXPosts } from "../jobs/analyze-x-posts.js";
import { collectXPosts } from "../jobs/collect-x-posts.js";
import { refreshRepoMetrics } from "../jobs/refresh-repo-metrics.js";
import { analyzeProduct } from "../products/analyze-product.js";
import { createProductFromRepo } from "../products/create-product-from-repo.js";
import { setProductMonitor } from "../products/monitor-product.js";
import {
  createProcessRegistry,
  observeProduct,
  type ObservationPersistence,
} from "../products/observe-product.js";
import { resolveProduct, type ProductResolution, type ResolverStore } from "../products/resolve-product.js";
import { buildProductReport } from "../reports/product-report.js";
import { renderProductReport } from "../reports/markdown-renderer.js";
import {
  loadPotentialRepositories,
  renderPotentialList,
  type PotentialListOptions,
} from "../reports/potential-list.js";
import {
  loadTrendingLists,
  renderTrendingLists,
  type TrendingListOptions,
} from "../reports/trending-list.js";
import type { JobInput } from "../jobs/job-runner.js";
import { GitHubHttpClientFactory } from "../sources/github/github-http-client.js";
import { TwitterCliSource } from "../sources/x/twitter-cli-source.js";
import type { XSourceAdapter } from "../sources/x/x-source.js";
import { GitHubTrendingSource } from "../sources/trending/github-trending-source.js";
import type { CliDependencies } from "./index.js";
import { createJobDispatcher } from "./job-dispatcher.js";
import { processIo, type CliIo, type CommandOutput } from "./output.js";

export interface DatabaseCliOptions {
  pool: Pool;
  userId: string;
  io?: CliIo;
  now?: () => Date;
  createProductFromGithub?: (fullName: string) => Promise<{ productId: string }>;
  observeResolved?: (productId: string) => Promise<CommandOutput>;
  runJob?: (input: JobInput) => Promise<CommandOutput>;
}

export interface ReadonlySignalCliOptions {
  pool: Pool;
  io?: CliIo;
  now?: () => Date;
}

export interface CliRuntime {
  dependencies: CliDependencies;
  close(): Promise<void>;
}

type RuntimeEnvironment = Record<string, string | undefined>;

export function createLazyProductionCliRuntime(
  env: RuntimeEnvironment,
  io: CliIo = processIo,
): CliRuntime {
  let fullRuntime: Promise<CliRuntime> | undefined;
  let readonlyRuntime: Promise<CliRuntime> | undefined;
  const getFull = () => fullRuntime ??= createProductionCliRuntime(env, io);
  const getReadonly = () => readonlyRuntime ??= createReadonlyProductionCliRuntime(env, io);
  return {
    dependencies: {
      io,
      now: () => new Date(),
      potential: async (options) => (await getReadonly()).dependencies.potential(options),
      trending: async (options) => (await getReadonly()).dependencies.trending(options),
      today: async () => (await getFull()).dependencies.today(),
      analyze: async (target) => (await getFull()).dependencies.analyze(target),
      observe: async (target) => (await getFull()).dependencies.observe(target),
      follow: async (target) => (await getFull()).dependencies.follow(target),
      listMonitors: async () => (await getFull()).dependencies.listMonitors(),
      unfollow: async (target) => (await getFull()).dependencies.unfollow(target),
      runJob: async (input) => (await getFull()).dependencies.runJob(input),
    },
    close: async () => {
      const runtimes = [fullRuntime, readonlyRuntime].filter(
        (runtime): runtime is Promise<CliRuntime> => runtime !== undefined,
      );
      await Promise.all(runtimes.map(async (runtime) => {
        try {
          await (await runtime).close();
        } catch {
          // Command execution already emitted a redacted configuration error.
        }
      }));
    },
  };
}

async function createReadonlyProductionCliRuntime(
  env: RuntimeEnvironment,
  io: CliIo,
): Promise<CliRuntime> {
  const config = loadReadonlyRuntimeConfig(env);
  const pool = new PgPool({ connectionString: config.runtimeDatabaseUrl, max: 2 });
  try {
    await pool.query("select 1");
  } catch (error) {
    await pool.end();
    throw error;
  }
  const signals = createReadonlySignalCliDependencies({ pool, io });
  const unavailable = async (): Promise<never> => { throw codedError("configuration_error"); };
  return {
    dependencies: {
      io,
      now: () => new Date(),
      potential: signals.potential,
      trending: signals.trending,
      today: unavailable,
      analyze: unavailable,
      observe: unavailable,
      follow: unavailable,
      listMonitors: unavailable,
      unfollow: unavailable,
      runJob: unavailable,
    },
    close: async () => pool.end(),
  };
}

async function createProductionCliRuntime(
  env: RuntimeEnvironment,
  io: CliIo,
): Promise<CliRuntime> {
  const config = loadRuntimeConfig(env);
  const pool = new PgPool({ connectionString: config.runtimeDatabaseUrl, max: 4 });
  const lockPool = new PgPool({ connectionString: config.runtimeDatabaseUrl, max: 2 });
  const http = createHttpTransport(env);
  await pool.query("select 1");
  const github = new GitHubHttpClientFactory({ token: config.githubToken, fetcher: http.fetcher });
  const scheduledX = createManagedTwitterSource(config.twitterCliPath, env.PATH);
  const scheduledAnalyzer = config.deepseekApiKey
      ? new ModelContentAnalyzer({
        apiKey: config.deepseekApiKey,
        baseUrl: config.deepseekBaseUrl,
        model: config.deepseekModel,
        fetcher: http.fetcher,
      })
    : null;
  const runJob = createJobDispatcher({
    pool,
    lockPool,
    loadedSecrets: loadedSecretValues(config),
    githubSourceFactory: github,
    trendingSource: new GitHubTrendingSource({ fetcher: http.fetcher }),
    xSource: scheduledX.source,
    analyzer: scheduledAnalyzer,
    cleanupX: scheduledX.cleanup,
  });
  const dependencies = createDatabaseCliDependencies({
    pool,
    userId: config.userId,
    io,
    runJob,
    createProductFromGithub: async (fullName) => {
      const operation = await github.openOperation();
      try {
        const repository = await operation.getRepository(fullName);
        const hasReadme = await operation.hasReadme(fullName);
        const observedAt = new Date();
        const hydrated = { ...repository, hasReadme };
        const created = await createProductFromRepo(pool, hydrated, {}, async (client, persisted) => {
          await new SnapshotStore(client).insert({
            repositoryId: persisted.repositoryId,
            capturedAt: observedAt,
            granularity: "realtime",
            stars: hydrated.stars,
            forks: hydrated.forks,
            commits30d: null,
            prTotal: null,
            prOpen: null,
            prMerged: null,
            releasesCount: null,
            issuesTotal: null,
            issuesOpen: null,
            issuesClosed: null,
            candidateBuckets: [],
            candidateRuleVersion: null,
            collectedFields: {
              core: true,
              source: "user_url",
              observed_at: observedAt.toISOString(),
              metadata: {
                name: hydrated.name,
                full_name: hydrated.fullName,
                description: hydrated.description,
                repo_url: hydrated.repoUrl,
                homepage_url: hydrated.homepageUrl,
              },
            },
          });
        });
        return { productId: created.productId };
      } finally {
        await operation.close();
      }
    },
    observeResolved: async (productId) => {
      const observedAt = new Date();
      const realtimeX = createManagedTwitterSource(config.twitterCliPath, env.PATH);
      let result;
      try {
        result = await observeProduct({
        latestFreshness: async (id) => loadProductFreshness(pool, id),
        refreshGithub: async (id, signal) => {
          const repositoryIds = (await pool.query<{ repository_id: string }>(
            "select repository_id from ace_hunter.product_repositories where product_id=$1 and is_primary",
            [id],
          )).rows.map((row) => row.repository_id);
          const cancellableGithub = new GitHubHttpClientFactory({ token: config.githubToken, signal, fetcher: http.fetcher });
          return refreshRepoMetrics({ pool, sourceFactory: cancellableGithub, now: () => observedAt }, {
            scheduledFor: observedAt, granularity: "realtime", repositoryIds,
          });
        },
        collectX: async (id) => collectXPosts({ pool, source: realtimeX.source }, { productId: id, observedAt }),
        analyzeX: async (id, _collected, signal) => {
          if (!config.deepseekApiKey) throw codedError("configuration_error");
          const analyzer = new ModelContentAnalyzer({
            apiKey: config.deepseekApiKey,
            baseUrl: config.deepseekBaseUrl,
            model: config.deepseekModel,
            signal,
            fetcher: http.fetcher,
          });
          return analyzeXPosts({ pool, analyzer }, { productId: id, observedAt });
        },
        killActiveChildren: realtimeX.cleanup,
        persist: async (observation) => persistRealtimeObservation(pool, observation, config.userId),
        enqueueComments: async () => undefined,
      }, productId, { deadlineMs: 60_000, now: observedAt });
      } finally {
        await realtimeX.cleanup();
      }
      const stored = await pool.query<{ structured_content: unknown; rendered_markdown: string }>(
        "select structured_content,rendered_markdown from ace_hunter.analysis_outputs where id=$1",
        [result.observationId],
      );
      return {
        kind: "realtime_observation",
        status: result.status,
        completedSources: result.completedSources,
        missingSources: result.missingSources,
        observationId: result.observationId,
        structuredContent: {
          kind: "realtime_observation",
          status: result.status,
          completedSources: result.completedSources,
          missingSources: result.missingSources,
          observationId: result.observationId,
          content: stored.rows[0].structured_content,
        },
        renderedMarkdown: stored.rows[0].rendered_markdown,
      };
    },
  });
  return {
    dependencies,
    close: async () => {
      await Promise.all([pool.end(), lockPool.end(), http.close()]);
    },
  };
}

export function resolveExecutablePath(command: string, pathValue: string | undefined): string {
  if (isAbsolute(command)) return verifiedExecutable(command);
  if (!/^[A-Za-z0-9_.-]+$/u.test(command)) throw codedError("configuration_error");
  for (const directory of (pathValue ?? "").split(delimiter)) {
    if (directory === "" || !isAbsolute(directory)) continue;
    try {
      return verifiedExecutable(join(directory, command));
    } catch {
      // Continue searching PATH; disclose neither candidates nor filesystem errors.
    }
  }
  throw codedError("configuration_error");
}

function verifiedExecutable(path: string): string {
  accessSync(path, constants.X_OK);
  return realpathSync(path);
}

function createManagedTwitterSource(command: string, pathValue: string | undefined): {
  source: XSourceAdapter;
  cleanup: () => Promise<void>;
} {
  const registry = createProcessRegistry();
  let concrete: TwitterCliSource | undefined;
  const get = () => concrete ??= new TwitterCliSource({
    cliPath: resolveExecutablePath(command, pathValue),
    spawnProcess: (executable, args, options) => {
      const child = spawn(executable, [...args], options) as ChildProcessWithoutNullStreams;
      registry.register(child);
      return child;
    },
  });
  return {
    source: {
      capabilities: () => ({ recentSearchDays: 7, replies: true }),
      assertAuthenticated: () => get().assertAuthenticated(),
      searchPosts: (input) => get().searchPosts(input),
      searchReplies: (conversationId, since, limit) => get().searchReplies(conversationId, since, limit),
      getArticle: (tweetId) => get().getArticle(tweetId),
    },
    cleanup: () => registry.killActiveChildren(),
  };
}

export function createDatabaseCliDependencies(options: DatabaseCliOptions): CliDependencies {
  const now = options.now ?? (() => new Date());
  const signals = createReadonlySignalCliDependencies({ pool: options.pool, io: options.io, now });
  const store = resolverStore(options.pool);
  const resolve = (target: string) => resolveProduct(store, target, {
    createFromGithub: options.createProductFromGithub,
  });
  return {
    io: options.io ?? processIo,
    now,
    potential: signals.potential,
    trending: signals.trending,
    today: async () => today(options.pool),
    analyze: async (target) => analyzeResolved(options.pool, await resolve(target), now(), options.userId),
    observe: async (target) => {
      const resolution = await resolve(target);
      if (resolution.kind !== "found") return resolution;
      if (!options.observeResolved) throw codedError("configuration_error");
      return options.observeResolved(resolution.productId);
    },
    follow: async (target) => monitorResolved(options, await resolve(target), true, now()),
    listMonitors: async () => listMonitors(options.pool, options.userId),
    unfollow: async (target) => monitorResolved(options, await resolve(target), false, now()),
    runJob: options.runJob ?? (async () => { throw codedError("configuration_error"); }),
  };
}

export function createReadonlySignalCliDependencies(options: ReadonlySignalCliOptions): Pick<
  CliDependencies,
  "io" | "now" | "potential" | "trending"
> {
  const now = options.now ?? (() => new Date());
  return {
    io: options.io ?? processIo,
    now,
    potential: async (input) => potential(options.pool, { ...input, now: now() }),
    trending: async (input) => trending(options.pool, { ...input, now: now() }),
  };
}

async function potential(pool: Pool, options: PotentialListOptions): Promise<CommandOutput> {
  const value = await loadPotentialRepositories(pool, options);
  return {
    kind: value.kind,
    structuredContent: value,
    renderedMarkdown: renderPotentialList(value),
  };
}

async function trending(pool: Pool, options: TrendingListOptions): Promise<CommandOutput> {
  const value = await loadTrendingLists(pool, options);
  return {
    kind: value.kind,
    structuredContent: value,
    renderedMarkdown: renderTrendingLists(value),
  };
}

function resolverStore(pool: Pool): ResolverStore {
  return {
    byGithubFullName: async (value) => (await pool.query<{ id: string; name: string }>(
      `select p.id,p.name from ace_hunter.products p
       join ace_hunter.product_repositories pr on pr.product_id=p.id and pr.is_primary
       join ace_hunter.repositories r on r.id=pr.repository_id
       where p.status='active' and r.status='active' and lower(r.full_name)=lower($1)
       order by p.name,p.id`, [value],
    )).rows,
    byName: async (value) => (await pool.query<{ id: string; name: string }>(
      `select id,name from ace_hunter.products
       where status='active' and lower(name)=lower($1) order by name,id`, [value],
    )).rows,
  };
}

async function today(pool: Pool): Promise<CommandOutput> {
  const result = await pool.query<{
    id: string;
    status: string;
    data_cutoff_at: Date;
    structured_content: unknown;
    rendered_markdown: string;
  }>(`select id,status,data_cutoff_at,structured_content,rendered_markdown
      from ace_hunter.analysis_outputs where output_type='daily_report'
        and status in ('complete','partial')
      order by period_end desc,completed_at desc,id desc limit 1`);
  const row = result.rows[0];
  if (!row) return { kind: "not_found", reason: "daily_report_unavailable" };
  return {
    kind: "daily_report",
    id: row.id,
    status: row.status,
    dataCutoffAt: row.data_cutoff_at,
    structuredContent: {
      kind: "daily_report",
      id: row.id,
      status: row.status,
      dataCutoffAt: row.data_cutoff_at,
      content: row.structured_content,
    },
    renderedMarkdown: row.rendered_markdown,
  };
}

async function analyzeResolved(
  pool: Pool,
  resolution: ProductResolution,
  at: Date,
  userId: string,
): Promise<CommandOutput> {
  if (resolution.kind !== "found") return resolution;
  const result = await analyzeProduct({
    loadLatestFacts: async (productId, cutoff) => {
      const item = await loadProductItem(pool, productId, cutoff);
      if (!item) return null;
      const missingSources = item.xFacts.status === "unavailable" ? ["x"] : [];
      return { item, completedSources: missingSources.length ? ["github"] : ["github", "x"], missingSources };
    },
    persistAnalysis: async (input) => {
      const facts = input.facts as {
        item: Awaited<ReturnType<typeof loadProductItem>>;
        completedSources: string[];
        missingSources: string[];
      };
      if (!facts.item) throw new Error("missing_product_item");
      const report = buildProductReport({
        outputType: "product_analysis",
        dataCutoffAt: input.dataCutoffAt,
        status: input.status,
        item: facts.item,
        completedSources: facts.completedSources,
        missingSources: facts.missingSources,
      });
      return new AnalysisOutputStore(pool).upsert({
        outputType: "product_analysis",
        userId,
        productId: input.productId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        dataCutoffAt: input.dataCutoffAt,
        status: input.status,
        title: `产品分析：${facts.item.name ?? input.productId}`,
        summary: facts.item.conclusion,
        structuredContent: { report },
        renderedMarkdown: renderProductReport(report),
        analysisVersion: "product-report-v1",
        triggerType: "manual",
        startedAt: input.dataCutoffAt,
        completedAt: input.dataCutoffAt,
      });
    },
  }, resolution.productId, { now: at });
  if (result.kind === "not_found") return result;
  const stored = await pool.query<{ structured_content: unknown; rendered_markdown: string }>(
    "select structured_content,rendered_markdown from ace_hunter.analysis_outputs where id=$1",
    [result.analysisId],
  );
  return {
    kind: "product_analysis",
    analysisId: result.analysisId,
    status: result.status,
    structuredContent: {
      kind: "product_analysis",
      analysisId: result.analysisId,
      status: result.status,
      content: stored.rows[0].structured_content,
    },
    renderedMarkdown: stored.rows[0].rendered_markdown,
  };
}

async function loadProductItem(pool: Pool, productId: string, cutoff: Date) {
  const result = await pool.query<{
    product_id: string;
    name: string;
    repo_url: string;
    homepage_url: string | null;
    observed_at: Date;
    stars: string;
    forks: string | null;
    x_status: "success_with_results" | "success_empty" | "unavailable" | "not_collected";
    x_posts: number;
    x_authors: number;
    x_engagement: string;
  }>(`select p.id product_id,p.name,r.repo_url,r.homepage_url,
      coalesce(nullif(s.collected_fields->>'observed_at','')::timestamptz,s.created_at) observed_at,
      s.stars,s.forks,p.x_collection_status x_status,
      (select count(*)::int from ace_hunter.product_x_posts x where x.product_id=p.id
        and x.post_type in ('original','article') and not x.is_duplicate and x.relevance_score>=0.6
        and x.analyzed_at<=$2 and x.x_created_at<=$2) x_posts,
      (select count(distinct author_id)::int from ace_hunter.product_x_posts x where x.product_id=p.id
        and x.post_type in ('original','article') and not x.is_duplicate and x.relevance_score>=0.6
        and x.analyzed_at<=$2 and x.x_created_at<=$2) x_authors,
      (select coalesce(sum(likes+reposts+quotes+replies+coalesce(bookmarks,0)),0)::bigint
        from ace_hunter.product_x_posts x where x.product_id=p.id
        and x.post_type in ('original','article') and not x.is_duplicate and x.relevance_score>=0.6
        and x.analyzed_at<=$2 and x.x_created_at<=$2) x_engagement
    from ace_hunter.products p
    join ace_hunter.product_repositories pr on pr.product_id=p.id and pr.is_primary
    join ace_hunter.repositories r on r.id=pr.repository_id
    join lateral (select * from ace_hunter.repository_snapshots snapshot
      where snapshot.repository_id=r.id and snapshot.captured_at<=$2
        and coalesce(nullif(snapshot.collected_fields->>'observed_at','')::timestamptz,snapshot.created_at)<=$2
      order by snapshot.captured_at desc,snapshot.id desc limit 1) s on true
    where p.id=$1 and p.status='active' and r.status='active'`, [productId, cutoff]);
  const row = result.rows[0];
  if (!row) return null;
  const stars = safeCount(row.stars, "stars");
  const xAvailable = row.x_status === "success_with_results" || row.x_status === "success_empty";
  const xStatus = row.x_status === "success_with_results" ? "success_with_results" as const
    : row.x_status === "success_empty" ? "success_empty" as const
      : "unavailable" as const;
  return {
    productId: row.product_id,
    name: row.name,
    repositoryUrl: row.repo_url,
    homepageUrl: row.homepage_url,
    capturedAt: row.observed_at.toISOString(),
    conclusion: "基于已采集事实生成的当前产品观察",
    score: { attentionScore: null },
    githubFacts: { stars, forks: row.forks === null ? null : safeCount(row.forks, "forks") },
    xFacts: xAvailable
      ? {
          status: xStatus,
          posts: row.x_posts,
          authors: row.x_authors,
          engagement: safeCount(row.x_engagement, "xEngagement"),
        }
      : { status: "unavailable" as const },
    representativePosts: [],
    risks: xAvailable ? [] : ["X 数据源不完整"],
  };
}

async function monitorResolved(
  options: DatabaseCliOptions,
  resolution: ProductResolution,
  active: boolean,
  at: Date,
): Promise<CommandOutput> {
  if (resolution.kind !== "found") return resolution;
  const client = await options.pool.connect();
  try {
    await client.query("begin");
    const result = await setProductMonitor({
      upsert: async (input) => (await client.query<{ id: string }>(`insert into ace_hunter.user_product_monitors
        (user_id,product_id,status,started_at,updated_at) values($1,$2,$3,$4,$4)
        on conflict(user_id,product_id) do update set status=excluded.status,updated_at=excluded.updated_at
        returning id`, [input.userId, input.productId, input.status, at])).rows[0].id,
    }, { userId: options.userId, productId: resolution.productId, active });
    const jobName = active ? "user_follow" : "user_unfollow";
    await client.query(`insert into ace_hunter.job_runs
      (job_name,trigger_type,scheduled_for,parameters,status,started_at,completed_at,
       items_expected,items_succeeded,items_failed,items_skipped,idempotency_key)
      values($1,'user',$2,$3,'success',$2,$2,1,1,0,0,$4)`, [
      jobName,
      at,
      JSON.stringify({ userId: options.userId, productId: resolution.productId }),
      `${jobName}:${options.userId}:${resolution.productId}:${randomUUID()}`,
    ]);
    await client.query("commit");
    return { kind: active ? "followed" : "unfollowed", productId: resolution.productId, ...result };
  } catch (error) {
    try { await client.query("rollback"); } catch { /* preserve primary failure */ }
    throw error;
  } finally {
    client.release();
  }
}

async function listMonitors(pool: Pool, userId: string): Promise<CommandOutput> {
  const monitors = (await pool.query(`select m.id "monitorId",m.product_id "productId",p.name,m.status,
      m.started_at "startedAt",m.last_observed_at "lastObservedAt"
    from ace_hunter.user_product_monitors m join ace_hunter.products p on p.id=m.product_id
    where m.user_id=$1 order by (m.status='active') desc,p.name,p.id`, [userId])).rows;
  return { monitors };
}

function safeCount(value: string | number, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`unsafe_product_numeric:${field}`);
  return parsed;
}

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

export async function loadProductFreshness(
  pool: Pool,
  productId: string,
): Promise<{ githubAt: Date | null; xAt: Date | null }> {
  const row = (await pool.query<{
    github_at: Date | null;
    x_at: Date | null;
  }>(`select
      (select max(coalesce(nullif(s.collected_fields->>'observed_at','')::timestamptz,s.created_at))
       from ace_hunter.product_repositories pr
       join ace_hunter.repository_snapshots s on s.repository_id=pr.repository_id
       where pr.product_id=$1 and pr.is_primary) github_at,
      (select case
         when p.x_collection_status='success_empty' then p.x_last_success_at
         when p.x_collection_status='success_with_results' and not exists (
           select 1 from ace_hunter.product_x_posts pending
           where pending.product_id=p.id and pending.post_type in ('original','article')
             and not pending.is_duplicate and pending.analyzed_at is null
         ) then greatest(p.x_last_success_at,
           (select max(analyzed_at) from ace_hunter.product_x_posts analyzed where analyzed.product_id=p.id))
         else null
       end from ace_hunter.products p where p.id=$1) x_at`,
  [productId])).rows[0];
  return { githubAt: row?.github_at ?? null, xAt: row?.x_at ?? null };
}

export async function persistRealtimeObservation(
  pool: Pool,
  observation: ObservationPersistence,
  userId?: string,
): Promise<string> {
  const item = await loadProductItem(pool, observation.productId, observation.dataCutoffAt);
  if (!item) throw new Error("product_facts_unavailable");
  const report = buildProductReport({
    outputType: "realtime_observation",
    dataCutoffAt: observation.dataCutoffAt,
    status: observation.status,
    item,
    completedSources: observation.completedSources,
    missingSources: observation.missingSources,
  });
  return new AnalysisOutputStore(pool).upsert({
    outputType: "realtime_observation",
    userId,
    productId: observation.productId,
    periodStart: observation.dataCutoffAt,
    periodEnd: observation.dataCutoffAt,
    dataCutoffAt: observation.dataCutoffAt,
    status: observation.status,
    title: `实时观察：${item.name ?? observation.productId}`,
    summary: item.conclusion,
    structuredContent: { report },
    renderedMarkdown: renderProductReport(report),
    analysisVersion: "product-report-v1",
    triggerType: "realtime",
    idempotencyKey: randomUUID(),
    startedAt: observation.dataCutoffAt,
    completedAt: new Date(),
  });
}
