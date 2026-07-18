import type { PoolClient } from "pg";

export const businessTables = [
  "analysis_outputs",
  "github_trending_snapshots",
  "job_runs",
  "product_repositories",
  "product_x_posts",
  "products",
  "repositories",
  "repository_snapshots",
  "user_product_monitors",
] as const;

const expectedIndexes = [
  "analysis_outputs_daily_unique",
  "analysis_outputs_pkey",
  "analysis_outputs_product_unique",
  "analysis_outputs_realtime_unique",
  "github_trending_snapshots_pkey",
  "job_runs_idempotency_unique",
  "job_runs_pkey",
  "monitor_user_product_unique",
  "product_repositories_one_primary",
  "product_repositories_pkey",
  "product_x_posts_pkey",
  "products_pkey",
  "repositories_github_node_id_key",
  "repositories_github_repo_id_key",
  "repositories_pkey",
  "repository_snapshots_bucket_unique",
  "repository_snapshots_pkey",
  "trending_rank_unique",
  "trending_repo_unique",
  "user_product_monitors_pkey",
  "x_post_product_unique",
] as const;

const expectedChecks = [
  "analysis_outputs_confidence_check",
  "analysis_outputs_output_type_check",
  "analysis_outputs_period_check",
  "analysis_outputs_status_check",
  "analysis_outputs_time_check",
  "analysis_outputs_trigger_check",
  "github_trending_snapshots_period_check",
  "github_trending_snapshots_rank_check",
  "github_trending_snapshots_stars_check",
  "job_runs_counts_check",
  "job_runs_status_check",
  "job_runs_time_check",
  "job_runs_trigger_check",
  "monitors_status_check",
  "product_repositories_confidence_check",
  "product_repositories_primary_role_check",
  "product_repositories_role_check",
  "product_x_posts_counts_check",
  "product_x_posts_reply_check",
  "product_x_posts_scores_check",
  "product_x_posts_sentiment_check",
  "product_x_posts_stance_check",
  "product_x_posts_type_check",
  "products_status_check",
  "products_x_collection_status_check",
  "repositories_owner_type_check",
  "repositories_status_check",
  "repository_snapshots_counts_check",
  "repository_snapshots_granularity_check",
  "trending_collection_status_check",
] as const;

const expectedConstraints = [
  "c:analysis_outputs_confidence_check:",
  "f:analysis_outputs_monitor_id_fkey:n",
  "c:analysis_outputs_output_type_check:",
  "c:analysis_outputs_period_check:",
  "p:analysis_outputs_pkey:",
  "f:analysis_outputs_product_id_fkey:r",
  "f:analysis_outputs_source_job_run_id_fkey:n",
  "c:analysis_outputs_status_check:",
  "c:analysis_outputs_time_check:",
  "c:analysis_outputs_trigger_check:",
  "f:analysis_outputs_user_id_fkey:n",
  "f:github_trending_snapshots_job_run_id_fkey:n",
  "c:github_trending_snapshots_period_check:",
  "p:github_trending_snapshots_pkey:",
  "c:github_trending_snapshots_rank_check:",
  "f:github_trending_snapshots_repository_id_fkey:r",
  "c:github_trending_snapshots_stars_check:",
  "c:job_runs_counts_check:",
  "f:job_runs_parent_run_id_fkey:n",
  "p:job_runs_pkey:",
  "c:job_runs_status_check:",
  "c:job_runs_time_check:",
  "c:job_runs_trigger_check:",
  "c:monitors_status_check:",
  "c:product_repositories_confidence_check:",
  "p:product_repositories_pkey:",
  "c:product_repositories_primary_role_check:",
  "f:product_repositories_product_id_fkey:c",
  "f:product_repositories_repository_id_fkey:c",
  "c:product_repositories_role_check:",
  "c:product_x_posts_counts_check:",
  "p:product_x_posts_pkey:",
  "f:product_x_posts_product_id_fkey:r",
  "c:product_x_posts_reply_check:",
  "f:product_x_posts_repository_id_fkey:r",
  "c:product_x_posts_scores_check:",
  "c:product_x_posts_sentiment_check:",
  "c:product_x_posts_stance_check:",
  "c:product_x_posts_type_check:",
  "p:products_pkey:",
  "c:products_status_check:",
  "c:products_x_collection_status_check:",
  "u:repositories_github_node_id_key:",
  "u:repositories_github_repo_id_key:",
  "c:repositories_owner_type_check:",
  "p:repositories_pkey:",
  "c:repositories_status_check:",
  "c:repository_snapshots_counts_check:",
  "c:repository_snapshots_granularity_check:",
  "p:repository_snapshots_pkey:",
  "f:repository_snapshots_repository_id_fkey:c",
  "c:trending_collection_status_check:",
  "p:user_product_monitors_pkey:",
  "f:user_product_monitors_product_id_fkey:r",
  "f:user_product_monitors_user_id_fkey:c",
] as const;

function same(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export async function assertCatalogIsAbsentOrComplete(
  client: PoolClient,
): Promise<"empty" | "complete"> {
  const namespace = await client.query<{ owner: string }>(
    `select pg_get_userbyid(nspowner) owner from pg_namespace where nspname='ace_hunter'`,
  );
  if (namespace.rowCount !== 1 || namespace.rows[0].owner !== "ace_hunter_owner") {
    throw new Error("catalog preflight failed: missing schema or wrong owner");
  }

  const relations = await client.query<{ relname: string; relkind: string; owner: string }>(
    `select c.relname,c.relkind,pg_get_userbyid(c.relowner) owner
       from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='ace_hunter' and c.relkind in ('r','v','m','S','f','p') order by 1`,
  );
  if (relations.rows.length === 0) return "empty";

  const tables = relations.rows.filter((row) => row.relkind === "r");
  if (
    relations.rows.length !== businessTables.length ||
    !same(
      tables.map((row) => row.relname),
      businessTables,
    ) ||
    tables.some((row) => row.owner !== "ace_hunter_owner")
  ) {
    throw new Error("catalog preflight failed: table manifest mismatch");
  }

  const indexes = await client.query<{ indexname: string }>(
    `select indexname from pg_indexes where schemaname='ace_hunter' order by 1`,
  );
  const checks = await client.query<{ conname: string }>(
    `select c.conname from pg_constraint c join pg_namespace n on n.oid=c.connamespace
      where n.nspname='ace_hunter' and c.contype='c' order by 1`,
  );
  const constraints = await client.query<{
    conname: string;
    contype: string;
    confdeltype: string | null;
  }>(
    `select c.conname,c.contype,case when c.contype='f' then c.confdeltype::text end confdeltype
       from pg_constraint c join pg_namespace n on n.oid=c.connamespace
      where n.nspname='ace_hunter' order by c.conname`,
  );
  const policies = await client.query<{ tablename: string; roles: string[]; cmd: string }>(
    `select tablename,roles,cmd from pg_policies where schemaname='ace_hunter' order by 1`,
  );
  const security = await client.query<{
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
    public_select: boolean;
    runtime_crud: boolean;
  }>(
    `select c.relrowsecurity,c.relforcerowsecurity,
            has_table_privilege('public',c.oid,'select') public_select,
            has_table_privilege('ace_hunter_runtime',c.oid,'select,insert,update,delete') runtime_crud
       from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='ace_hunter' and c.relkind='r'`,
  );

  if (
    !same(indexes.rows.map((row) => row.indexname), expectedIndexes) ||
    !same(checks.rows.map((row) => row.conname), expectedChecks) ||
    !same(
      constraints.rows.map(
        (row) => `${row.contype}:${row.conname}:${row.confdeltype ?? ""}`,
      ),
      expectedConstraints,
    ) ||
    policies.rows.length !== businessTables.length ||
    policies.rows.some(
      (row) => !row.roles.includes("ace_hunter_runtime") || row.cmd !== "ALL",
    ) ||
    security.rows.some(
      (row) =>
        !row.relrowsecurity ||
        !row.relforcerowsecurity ||
        row.public_select ||
        !row.runtime_crud,
    )
  ) {
    throw new Error("catalog preflight failed: security or object manifest mismatch");
  }
  return "complete";
}
