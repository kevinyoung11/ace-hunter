begin;
set local role ace_hunter_owner;

create table ace_hunter.products (
  id uuid constraint products_pkey primary key default gen_random_uuid(),
  name text not null,
  description text,
  website_url text,
  identifiers jsonb not null default '{}'::jsonb,
  status text not null constraint products_status_check check (status in ('active','inactive')),
  first_seen_at timestamptz not null default now(),
  x_last_attempted_at timestamptz,
  x_last_success_at timestamptz,
  x_collection_status text not null default 'not_collected'
    constraint products_x_collection_status_check
    check (x_collection_status in ('not_collected','success_with_results','success_empty','unavailable')),
  x_last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table ace_hunter.repositories (
  id uuid constraint repositories_pkey primary key default gen_random_uuid(),
  github_repo_id bigint not null constraint repositories_github_repo_id_key unique,
  github_node_id text constraint repositories_github_node_id_key unique,
  owner_id bigint,
  owner_login text not null,
  owner_type text constraint repositories_owner_type_check
    check (owner_type is null or owner_type in ('User','Organization')),
  owner_profile_url text,
  owner_avatar_url text,
  name text not null,
  full_name text not null,
  description text,
  repo_url text not null,
  homepage_url text,
  default_branch text,
  language text,
  license text,
  topics jsonb not null default '[]'::jsonb,
  has_readme boolean not null default false,
  github_created_at timestamptz not null,
  github_pushed_at timestamptz,
  is_fork boolean not null,
  is_archived boolean not null,
  is_template boolean not null,
  is_mirror boolean not null,
  status text not null constraint repositories_status_check
    check (status in ('active','inaccessible','deleted')),
  first_seen_at timestamptz not null default now(),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table ace_hunter.product_repositories (
  product_id uuid not null,
  repository_id uuid not null,
  role text not null constraint product_repositories_role_check check (role in ('primary','secondary')),
  is_primary boolean not null default false,
  confidence numeric constraint product_repositories_confidence_check check (confidence between 0 and 1),
  link_source text not null,
  created_at timestamptz not null default now(),
  constraint product_repositories_pkey primary key (product_id,repository_id),
  constraint product_repositories_product_id_fkey foreign key (product_id)
    references ace_hunter.products(id) on delete cascade,
  constraint product_repositories_repository_id_fkey foreign key (repository_id)
    references ace_hunter.repositories(id) on delete cascade,
  constraint product_repositories_primary_role_check check (not is_primary or role='primary')
);

create table ace_hunter.repository_snapshots (
  id uuid constraint repository_snapshots_pkey primary key default gen_random_uuid(),
  repository_id uuid not null,
  captured_at timestamptz not null,
  granularity text not null constraint repository_snapshots_granularity_check
    check (granularity in ('hourly','daily','realtime')),
  stars bigint not null,
  forks bigint,
  commits_30d integer,
  pr_total integer,
  pr_open integer,
  pr_merged integer,
  releases_count integer,
  latest_release_at timestamptz,
  latest_release_tag text,
  issues_total integer,
  issues_open integer,
  issues_closed integer,
  aux_metrics_captured_at timestamptz,
  candidate_buckets text[] not null default '{}',
  candidate_rule_version text,
  collected_fields jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint repository_snapshots_repository_id_fkey foreign key (repository_id)
    references ace_hunter.repositories(id) on delete cascade,
  constraint repository_snapshots_counts_check check (
    stars>=0 and (forks is null or forks>=0) and
    (commits_30d is null or commits_30d>=0) and
    (pr_total is null or pr_total>=0) and
    (pr_open is null or pr_open>=0) and
    (pr_merged is null or pr_merged>=0) and
    (releases_count is null or releases_count>=0) and
    (issues_total is null or issues_total>=0) and
    (issues_open is null or issues_open>=0) and
    (issues_closed is null or issues_closed>=0)
  )
);

create table ace_hunter.job_runs (
  id uuid constraint job_runs_pkey primary key default gen_random_uuid(),
  job_name text not null,
  trigger_type text not null constraint job_runs_trigger_check
    check (trigger_type in ('schedule','manual','realtime','user')),
  parent_run_id uuid,
  scheduled_for timestamptz not null,
  parameters jsonb not null default '{}'::jsonb,
  status text not null constraint job_runs_status_check
    check (status in ('running','success','partial','failed')),
  started_at timestamptz not null,
  completed_at timestamptz,
  data_cutoff_at timestamptz,
  items_expected integer,
  items_succeeded integer,
  items_failed integer,
  items_skipped integer,
  failed_items jsonb not null default '[]'::jsonb,
  error_summary text,
  attempt integer not null default 0,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  constraint job_runs_parent_run_id_fkey foreign key (parent_run_id)
    references ace_hunter.job_runs(id) on delete set null,
  constraint job_runs_time_check check (completed_at is null or completed_at>=started_at),
  constraint job_runs_counts_check check (
    attempt between 0 and 2 and coalesce(items_expected,0)>=0 and
    coalesce(items_succeeded,0)>=0 and coalesce(items_failed,0)>=0 and
    coalesce(items_skipped,0)>=0
  )
);

create table ace_hunter.github_trending_snapshots (
  id uuid constraint github_trending_snapshots_pkey primary key default gen_random_uuid(),
  repository_id uuid not null,
  period text not null constraint github_trending_snapshots_period_check
    check (period in ('daily','weekly','monthly')),
  language text not null default 'all',
  captured_at timestamptz not null,
  rank integer not null constraint github_trending_snapshots_rank_check check (rank > 0),
  stars_in_period bigint,
  source_url text not null,
  collection_status text not null constraint trending_collection_status_check
    check (collection_status in ('success','partial')),
  job_run_id uuid,
  created_at timestamptz not null default now(),
  constraint github_trending_snapshots_repository_id_fkey foreign key (repository_id)
    references ace_hunter.repositories(id) on delete restrict,
  constraint github_trending_snapshots_job_run_id_fkey foreign key (job_run_id)
    references ace_hunter.job_runs(id) on delete set null,
  constraint github_trending_snapshots_stars_check check (stars_in_period is null or stars_in_period>=0)
);

create table ace_hunter.product_x_posts (
  id uuid constraint product_x_posts_pkey primary key default gen_random_uuid(),
  product_id uuid not null,
  repository_id uuid,
  x_post_id text not null,
  conversation_id text,
  root_post_id text,
  in_reply_to_post_id text,
  post_type text not null constraint product_x_posts_type_check
    check (post_type in ('original','comment','article')),
  author_id text not null,
  author_username text not null,
  author_name text,
  author_verified boolean,
  content text not null,
  language text,
  post_url text not null,
  x_created_at timestamptz not null,
  likes bigint not null default 0,
  reposts bigint not null default 0,
  quotes bigint not null default 0,
  replies bigint not null default 0,
  bookmarks bigint,
  views bigint,
  metrics_updated_at timestamptz,
  match_method text,
  matched_identifier text,
  relation_source text,
  relevance_score numeric,
  topic text,
  sentiment text constraint product_x_posts_sentiment_check
    check (sentiment is null or sentiment in ('positive','neutral','negative')),
  stance text constraint product_x_posts_stance_check
    check (stance is null or stance in ('support','question','challenge','bug','neutral','spam')),
  is_duplicate boolean not null default false,
  duplicate_cluster_id text,
  automation_probability numeric,
  is_project_affiliated boolean,
  analysis_version text,
  model_name text,
  analyzed_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_x_posts_product_id_fkey foreign key (product_id)
    references ace_hunter.products(id) on delete restrict,
  constraint product_x_posts_repository_id_fkey foreign key (repository_id)
    references ace_hunter.repositories(id) on delete restrict,
  constraint product_x_posts_scores_check check (
    (relevance_score is null or relevance_score between 0 and 1) and
    (automation_probability is null or automation_probability between 0 and 1)
  ),
  constraint product_x_posts_counts_check check (
    likes>=0 and reposts>=0 and quotes>=0 and replies>=0 and
    (bookmarks is null or bookmarks>=0) and (views is null or views>=0)
  ),
  constraint product_x_posts_reply_check check (
    post_type<>'comment' or in_reply_to_post_id is not null
  )
);

create table ace_hunter.user_product_monitors (
  id uuid constraint user_product_monitors_pkey primary key default gen_random_uuid(),
  user_id uuid not null,
  product_id uuid not null,
  status text not null constraint monitors_status_check check (status in ('active','inactive')),
  started_at timestamptz not null default now(),
  last_observed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_product_monitors_user_id_fkey foreign key (user_id)
    references auth.users(id) on delete cascade,
  constraint user_product_monitors_product_id_fkey foreign key (product_id)
    references ace_hunter.products(id) on delete restrict
);

create table ace_hunter.analysis_outputs (
  id uuid constraint analysis_outputs_pkey primary key default gen_random_uuid(),
  output_type text not null constraint analysis_outputs_output_type_check
    check (output_type in ('daily_report','product_analysis','realtime_observation')),
  user_id uuid,
  product_id uuid,
  monitor_id uuid,
  period_start timestamptz not null,
  period_end timestamptz not null,
  data_cutoff_at timestamptz not null,
  status text not null constraint analysis_outputs_status_check
    check (status in ('running','complete','partial','failed')),
  verdict text,
  confidence numeric constraint analysis_outputs_confidence_check
    check (confidence is null or confidence between 0 and 1),
  title text not null,
  summary text,
  structured_content jsonb not null default '{}'::jsonb,
  rendered_markdown text not null,
  analysis_version text not null,
  model_name text,
  trigger_type text not null constraint analysis_outputs_trigger_check
    check (trigger_type in ('schedule','manual','realtime')),
  idempotency_key text,
  source_job_run_id uuid,
  started_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint analysis_outputs_user_id_fkey foreign key (user_id)
    references auth.users(id) on delete set null,
  constraint analysis_outputs_product_id_fkey foreign key (product_id)
    references ace_hunter.products(id) on delete restrict,
  constraint analysis_outputs_monitor_id_fkey foreign key (monitor_id)
    references ace_hunter.user_product_monitors(id) on delete set null,
  constraint analysis_outputs_source_job_run_id_fkey foreign key (source_job_run_id)
    references ace_hunter.job_runs(id) on delete set null,
  constraint analysis_outputs_period_check check (period_end>=period_start),
  constraint analysis_outputs_time_check check (completed_at is null or completed_at>=started_at)
);

create unique index product_repositories_one_primary
  on ace_hunter.product_repositories(product_id) where is_primary;
create unique index analysis_outputs_daily_unique
  on ace_hunter.analysis_outputs(output_type,period_start,period_end)
  where output_type='daily_report' and user_id is null and product_id is null;
create unique index analysis_outputs_product_unique
  on ace_hunter.analysis_outputs(output_type,product_id,period_start,period_end)
  where output_type='product_analysis' and product_id is not null;
create unique index analysis_outputs_realtime_unique
  on ace_hunter.analysis_outputs(output_type,product_id,idempotency_key)
  where output_type='realtime_observation' and product_id is not null and idempotency_key is not null;
create unique index repository_snapshots_bucket_unique
  on ace_hunter.repository_snapshots(repository_id,captured_at,granularity);
create unique index trending_repo_unique
  on ace_hunter.github_trending_snapshots(period,language,captured_at,repository_id);
create unique index trending_rank_unique
  on ace_hunter.github_trending_snapshots(period,language,captured_at,rank);
create unique index x_post_product_unique
  on ace_hunter.product_x_posts(product_id,x_post_id);
create unique index monitor_user_product_unique
  on ace_hunter.user_product_monitors(user_id,product_id);
create unique index job_runs_idempotency_unique
  on ace_hunter.job_runs(idempotency_key);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'products','repositories','product_repositories','repository_snapshots',
    'github_trending_snapshots','product_x_posts','user_product_monitors',
    'analysis_outputs','job_runs'
  ] loop
    execute format('alter table ace_hunter.%I owner to ace_hunter_owner',table_name);
    execute format('revoke all on ace_hunter.%I from public',table_name);
    execute format('alter table ace_hunter.%I enable row level security',table_name);
    execute format('alter table ace_hunter.%I force row level security',table_name);
    execute format('grant select,insert,update,delete on ace_hunter.%I to ace_hunter_runtime',table_name);
    execute format(
      'create policy %I on ace_hunter.%I for all to ace_hunter_runtime using (true) with check (true)',
      table_name || '_runtime', table_name
    );
  end loop;
end
$$;

alter schema ace_hunter owner to ace_hunter_owner;
revoke all on schema ace_hunter from public;
grant usage on schema ace_hunter to ace_hunter_runtime;

commit;
