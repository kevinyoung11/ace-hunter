import type { Pool, PoolClient } from "pg";
import { contentDeduplicationKey } from "../analysis/deduplicate-posts.js";
import { buildProductQueries } from "../sources/x/query-builder.js";
import type { XPostFact, XSourceAdapter } from "../sources/x/x-source.js";
import { JobError, type JobResult } from "./job-runner.js";

export interface CollectXPostsDependencies { pool: Pool; source: XSourceAdapter }
export interface CollectXPostsOptions { productId: string; observedAt: Date }

interface ProductSearchRow {
  name: string; website_url: string | null; identifiers: Record<string, unknown>;
  x_last_success_at: Date | null; repository_id: string; full_name: string; repo_url: string;
}

export async function collectXPosts(
  dependencies: CollectXPostsDependencies,
  options: CollectXPostsOptions,
): Promise<JobResult> {
  validateOptions(options);
  const product = await readProduct(dependencies.pool, options.productId);
  if (product.x_last_success_at !== null && product.x_last_success_at > options.observedAt) {
    return { expected: 0, succeeded: 0, failed: [], skipped: 0 };
  }
  await markAttempted(dependencies.pool, options);
  const capabilities = dependencies.source.capabilities();
  if (!Number.isSafeInteger(capabilities.recentSearchDays) || capabilities.recentSearchDays < 7) {
    await markUnavailable(dependencies.pool, options, "source_unavailable");
    throw new JobError("source_unavailable", false, "X source cannot satisfy the seven-day window");
  }
  const domain = product.identifiers.domain ?? domainFromUrl(product.website_url);
  const queries = buildProductQueries({ name: product.name, fullName: product.full_name,
    repoUrl: product.repo_url, domain: typeof domain === "string" ? domain : null,
    isGenericName: product.identifiers.is_generic_name === true });
  const since = product.x_last_success_at === null
    ? new Date(options.observedAt.getTime() - 7 * 86_400_000)
    : new Date(product.x_last_success_at.getTime() - 6 * 3_600_000);
  const matched = new Map<string, { fact: XPostFact; query: string }>();
  try {
    await dependencies.source.assertAuthenticated();
    for (const query of queries) {
      const facts = await dependencies.source.searchPosts({ query, since, until: options.observedAt, limit: 50 });
      for (const sourceFact of facts.slice(0, 50)) {
        if (isRetweet(sourceFact) || matched.has(sourceFact.id)) continue;
        const fact = sourceFact.isArticle
          ? { ...sourceFact, content: (await dependencies.source.getArticle(sourceFact.id)).articleText, isArticle: true }
          : sourceFact;
        matched.set(fact.id, { fact, query });
      }
    }
  } catch {
    await markUnavailable(dependencies.pool, options, "source_unavailable");
    throw new JobError("source_unavailable", true, "X source unavailable");
  }
  const selected = [...matched.values()].sort((left, right) => compareHeat(left.fact, right.fact)).slice(0, 50);
  const existing = (await dependencies.pool.query<{ x_post_id: string; content: string }>(`select x_post_id,content
    from ace_hunter.product_x_posts where product_id=$1 and not is_duplicate
    order by first_seen_at,x_post_id`, [options.productId])).rows;
  const representatives = new Map<string, string>();
  for (const row of existing) {
    const key = contentDeduplicationKey(row.content);
    if (key !== null && !representatives.has(key)) representatives.set(key, row.x_post_id);
  }
  const clusters = new Map<string, string | null>();
  for (const item of selected) {
    const key = contentDeduplicationKey(item.fact.content);
    const representative = key === null ? undefined : representatives.get(key);
    clusters.set(item.fact.id, representative === item.fact.id ? null : representative ?? null);
    if (key !== null && representative === undefined) representatives.set(key, item.fact.id);
  }
  const client = await dependencies.pool.connect();
  try {
    await client.query("begin");
    for (const item of selected) {
      const duplicateClusterId = clusters.get(item.fact.id);
      if (duplicateClusterId === undefined) throw new Error("deduplication result mismatch");
      await upsertPost(client, { productId: options.productId, repositoryId: product.repository_id,
        fact: item.fact, postType: item.fact.isArticle ? "article" : "original", observedAt: options.observedAt,
        matchMethod: "search", matchedIdentifier: item.query, relationSource: "search", duplicateClusterId });
    }
    await client.query(`update ace_hunter.products set x_last_attempted_at=$2,x_last_success_at=$2,
      x_collection_status=$3,x_last_error_code=null,updated_at=$2 where id=$1 and x_last_attempted_at=$2`,
    [options.productId, options.observedAt, selected.length === 0 ? "success_empty" : "success_with_results"]);
    await client.query("commit");
  } catch (error) {
    try { await client.query("rollback"); } catch { /* preserve primary error */ }
    throw error;
  } finally { client.release(); }
  return { expected: selected.length, succeeded: selected.length, failed: [], skipped: 0 };
}

export async function upsertPost(client: PoolClient, input: {
  productId: string; repositoryId: string | null; fact: XPostFact; postType: "original" | "comment" | "article";
  observedAt: Date; matchMethod: string; matchedIdentifier: string; relationSource: string;
  duplicateClusterId: string | null;
}): Promise<void> {
  const fact = input.fact;
  await client.query(`insert into ace_hunter.product_x_posts
      (product_id,repository_id,x_post_id,conversation_id,root_post_id,in_reply_to_post_id,post_type,
       author_id,author_username,author_name,author_verified,content,language,post_url,x_created_at,
       likes,reposts,quotes,replies,bookmarks,views,metrics_updated_at,match_method,matched_identifier,
       relation_source,is_duplicate,duplicate_cluster_id,last_synced_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$22)
    on conflict(product_id,x_post_id) do update set
      repository_id=excluded.repository_id,conversation_id=excluded.conversation_id,root_post_id=excluded.root_post_id,
      in_reply_to_post_id=excluded.in_reply_to_post_id,post_type=excluded.post_type,
      author_id=excluded.author_id,author_username=excluded.author_username,author_name=excluded.author_name,
      author_verified=excluded.author_verified,content=excluded.content,language=excluded.language,
      post_url=excluded.post_url,x_created_at=excluded.x_created_at,likes=excluded.likes,reposts=excluded.reposts,
      quotes=excluded.quotes,replies=excluded.replies,bookmarks=excluded.bookmarks,views=excluded.views,
      metrics_updated_at=excluded.metrics_updated_at,match_method=excluded.match_method,
      matched_identifier=excluded.matched_identifier,relation_source=excluded.relation_source,
      is_duplicate=excluded.is_duplicate,duplicate_cluster_id=excluded.duplicate_cluster_id,
      last_synced_at=excluded.last_synced_at,updated_at=excluded.updated_at
    where product_x_posts.metrics_updated_at is null or excluded.metrics_updated_at>=product_x_posts.metrics_updated_at`, [input.productId, input.repositoryId, fact.id, fact.conversationId, fact.rootPostId,
    fact.inReplyToPostId, input.postType, fact.authorId, fact.authorUsername, fact.authorName,
    fact.authorVerified, fact.content, fact.language, fact.url, fact.createdAt, fact.likes, fact.reposts,
    fact.quotes, fact.replies, fact.bookmarks, fact.views, input.observedAt, input.matchMethod,
    input.matchedIdentifier, input.relationSource, input.duplicateClusterId !== null,
    input.duplicateClusterId]);
}

function validateOptions(options: CollectXPostsOptions): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(options.productId) || !Number.isFinite(options.observedAt.getTime())) {
    throw new JobError("validation_error", false, "invalid X collection input");
  }
}

async function readProduct(pool: Pool, productId: string): Promise<ProductSearchRow> {
  const result = await pool.query<ProductSearchRow>(`select p.name,p.website_url,p.identifiers,p.x_last_success_at,
      r.id repository_id,r.full_name,r.repo_url
    from ace_hunter.products p join ace_hunter.product_repositories pr on pr.product_id=p.id and pr.is_primary
    join ace_hunter.repositories r on r.id=pr.repository_id
    where p.id=$1 and p.status='active' and r.status='active'`, [productId]);
  if (result.rows.length !== 1) throw new JobError("validation_error", false, "active Product with Primary Repo not found");
  return result.rows[0];
}

async function markUnavailable(pool: Pool, options: CollectXPostsOptions, code: string): Promise<void> {
  await pool.query(`update ace_hunter.products set x_last_attempted_at=$2,x_collection_status='unavailable',
    x_last_error_code=$3,updated_at=$2 where id=$1 and x_last_attempted_at=$2`, [options.productId, options.observedAt, code]);
}

async function markAttempted(pool: Pool, options: CollectXPostsOptions): Promise<void> {
  await pool.query(`update ace_hunter.products set x_last_attempted_at=$2,updated_at=$2
    where id=$1 and (x_last_attempted_at is null or x_last_attempted_at<$2)`, [options.productId, options.observedAt]);
}

function domainFromUrl(value: string | null): string | null {
  if (value === null) return null;
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
}
function isRetweet(fact: XPostFact): boolean { return /^\s*RT\s+@/iu.test(fact.content); }
function engagement(fact: XPostFact): number { return fact.likes + fact.reposts + fact.quotes + fact.replies; }
function compareHeat(left: XPostFact, right: XPostFact): number {
  return engagement(right) - engagement(left) || right.createdAt.getTime() - left.createdAt.getTime() || left.id.localeCompare(right.id);
}
