-- Versioned control-plane schema.  Business tables remain owned by 0001.
set local search_path = ace_hunter, extensions, pg_catalog;

do $$ begin
  if not exists (select 1 from pg_roles where rolname='ace_hunter_ops')
     or not exists (select 1 from pg_roles where rolname='ace_hunter_github_runtime')
     or not exists (select 1 from pg_roles where rolname='ace_hunter_mac_worker') then
    raise exception 'ops roles must be provisioned by ops/03_bootstrap_ops_roles.sql before 0002 migration';
  end if;
end $$;

create table ace_hunter.job_definitions (
  name text primary key,
  display_name text not null,
  executor text not null check (executor in ('github','local')),
  capability text not null,
  workflow_file text not null,
  parameters_schema jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  paused_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table ace_hunter.job_commands (
  id uuid primary key default gen_random_uuid(),
  job_name text not null references ace_hunter.job_definitions(name) on delete restrict,
  executor text not null check (executor in ('github','local')),
  capability text not null,
  parameters jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','claimed','running','succeeded','partial','failed','cancelled')),
  idempotency_key text not null unique,
  scheduled_for timestamptz,
  claimed_by text,
  lease_until timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  job_run_id uuid references ace_hunter.job_runs(id) on delete set null,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_commands_scheduled_unique unique (job_name, scheduled_for)
    deferrable initially immediate
);

create table ace_hunter.worker_heartbeats (
  worker_id text primary key,
  executor text not null check (executor in ('github','local')),
  capabilities text[] not null default '{}',
  version text,
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table ace_hunter.ops_audit_log (
  id bigint generated always as identity primary key,
  actor text not null,
  action text not null,
  job_name text,
  command_id uuid references ace_hunter.job_commands(id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

insert into ace_hunter.job_definitions(name, display_name, executor, capability, workflow_file)
values
 ('discover_github_candidates','GitHub potential candidates','github','github.candidates','discover.yml'),
 ('collect_github_trending','GitHub trending','github','github.trending','trending.yml'),
 ('refresh_repo_metrics','Refresh repository metrics','github','github.metrics','refresh-metrics.yml'),
 ('collect_x_posts','Collect X posts','local','x.posts.collect','collect-x.yml'),
 ('analyze_x_posts','Analyze X posts','local','x.posts.analyze','collect-x.yml'),
 ('collect_x_comments','Collect X comments','local','x.comments.collect','collect-x.yml'),
 ('generate_report','Generate report','github','reports.daily','daily-report.yml'),
 ('evaluate_success','Evaluate success','github','maintenance.evaluate','evaluate-success.yml'),
 ('retention','Job retention','github','maintenance.retention','retention.yml')
on conflict (name) do update set display_name=excluded.display_name,
  executor=excluded.executor, capability=excluded.capability, workflow_file=excluded.workflow_file, updated_at=now();

alter table ace_hunter.job_definitions owner to ace_hunter_owner;
alter table ace_hunter.job_commands owner to ace_hunter_owner;
alter table ace_hunter.worker_heartbeats owner to ace_hunter_owner;
alter table ace_hunter.ops_audit_log owner to ace_hunter_owner;

alter table ace_hunter.job_definitions enable row level security;
alter table ace_hunter.job_commands enable row level security;
alter table ace_hunter.worker_heartbeats enable row level security;
alter table ace_hunter.ops_audit_log enable row level security;
alter table ace_hunter.job_definitions force row level security;
alter table ace_hunter.job_commands force row level security;
alter table ace_hunter.worker_heartbeats force row level security;
alter table ace_hunter.ops_audit_log force row level security;

-- Only SECURITY DEFINER functions below access command rows; direct table CRUD is denied.
-- The definer owner is deliberately the only RLS actor with a blanket policy;
-- executor roles still have no direct table privileges or policies.
create policy control_owner_job_definitions on ace_hunter.job_definitions
  for all to ace_hunter_owner using (true) with check (true);
create policy control_owner_job_commands on ace_hunter.job_commands
  for all to ace_hunter_owner using (true) with check (true);
create policy control_owner_worker_heartbeats on ace_hunter.worker_heartbeats
  for all to ace_hunter_owner using (true) with check (true);
create policy control_owner_audit on ace_hunter.ops_audit_log
  for all to ace_hunter_owner using (true) with check (true);
revoke all on ace_hunter.job_definitions, ace_hunter.job_commands,
  ace_hunter.worker_heartbeats, ace_hunter.ops_audit_log from public;
create policy ops_job_definitions_read on ace_hunter.job_definitions for select to ace_hunter_ops using (true);

create or replace function ace_hunter.create_job_command(p_job_name text, p_executor text, p_capability text, p_parameters jsonb, p_idempotency_key text, p_scheduled_for timestamptz default null)
returns ace_hunter.job_commands language plpgsql security definer volatile
set search_path = ace_hunter, pg_catalog as $$
declare
 result ace_hunter.job_commands;
 expected_executor text;
 expected_capability text;
begin
 select executor, capability into expected_executor, expected_capability
   from ace_hunter.job_definitions where name=p_job_name;
 if expected_executor is null then raise exception 'unknown_job' using errcode='22023'; end if;
 if p_executor <> expected_executor or p_capability <> expected_capability then
   raise exception 'job_definition_mismatch' using errcode='22023';
 end if;
 insert into ace_hunter.job_commands(job_name,executor,capability,parameters,idempotency_key,scheduled_for)
 values(p_job_name,p_executor,p_capability,coalesce(p_parameters,'{}'::jsonb),p_idempotency_key,p_scheduled_for)
 on conflict(idempotency_key) do update set idempotency_key=excluded.idempotency_key
 returning * into result;
 return result;
end $$;

create or replace function ace_hunter.list_job_definitions()
returns setof ace_hunter.job_definitions language sql security definer stable
set search_path = ace_hunter, pg_catalog as $$
 select * from ace_hunter.job_definitions order by name
$$;

create or replace function ace_hunter.record_ops_audit(p_actor text, p_action text, p_job_name text default null, p_command_id uuid default null, p_details jsonb default '{}'::jsonb)
returns ace_hunter.ops_audit_log language sql security definer volatile
set search_path = ace_hunter, pg_catalog as $$
 insert into ace_hunter.ops_audit_log(actor,action,job_name,command_id,details)
 values($1,$2,$3,$4,coalesce($5,'{}'::jsonb)) returning *
$$;

create or replace function ace_hunter.list_ops_audit(p_limit integer default 100)
returns setof ace_hunter.ops_audit_log language sql security definer stable
set search_path = ace_hunter, pg_catalog as $$
 select * from ace_hunter.ops_audit_log order by created_at desc limit greatest(0, least(coalesce($1,100), 1000))
$$;

create or replace function ace_hunter.claim_job_command(p_worker_id text, p_executor text, p_capabilities text[] default '{}')
returns ace_hunter.job_commands language plpgsql security definer volatile
set search_path = ace_hunter, pg_catalog as $$
declare result ace_hunter.job_commands;
begin
  update ace_hunter.job_commands c set status='queued', claimed_by=null, lease_until=null, updated_at=now()
   where c.status in ('claimed','running') and c.lease_until < now();
  select c.* into result from ace_hunter.job_commands c
   join ace_hunter.job_definitions j on j.name=c.job_name
  where c.status='queued' and j.enabled and j.paused_at is null
    and c.executor=p_executor and (p_capabilities is null or j.capability = any(p_capabilities))
  order by c.created_at limit 1 for update of c skip locked;
  if result.id is null then return null; end if;
  update ace_hunter.job_commands set status='claimed', claimed_by=p_worker_id,
    lease_until=now()+interval '5 minutes', updated_at=now() where id=result.id returning * into result;
  return result;
end $$;

create or replace function ace_hunter.start_job_command(p_command_id uuid, p_worker_id text)
returns ace_hunter.job_commands language plpgsql security definer volatile
set search_path = ace_hunter, pg_catalog as $$
declare result ace_hunter.job_commands;
begin
 update ace_hunter.job_commands set status='running', started_at=coalesce(started_at,now()), lease_until=now()+interval '5 minutes', updated_at=now()
  where id=p_command_id and status='claimed' and claimed_by=p_worker_id returning * into result;
 if result.id is null then raise exception 'command_not_claimed' using errcode='42501'; end if;
 return result;
end $$;

create or replace function ace_hunter.bind_job_run(p_command_id uuid, p_worker_id text, p_job_run_id uuid)
returns ace_hunter.job_commands language plpgsql security definer volatile
set search_path = ace_hunter, pg_catalog as $$
declare result ace_hunter.job_commands;
begin
 update ace_hunter.job_commands set job_run_id=p_job_run_id, updated_at=now()
  where id=p_command_id and claimed_by=p_worker_id and status='running' returning * into result;
 if result.id is null then raise exception 'command_not_owned' using errcode='42501'; end if;
 return result;
end $$;

create or replace function ace_hunter.complete_job_command(p_command_id uuid, p_worker_id text, p_status text, p_error_code text default null, p_error_message text default null)
returns ace_hunter.job_commands language plpgsql security definer volatile
set search_path = ace_hunter, pg_catalog as $$
declare result ace_hunter.job_commands;
begin
 if p_status not in ('succeeded','partial','failed') then raise exception 'invalid_terminal_status' using errcode='22023'; end if;
 update ace_hunter.job_commands set status=p_status, finished_at=now(), lease_until=null,
  error_code=p_error_code, error_message=p_error_message, updated_at=now()
  where id=p_command_id and claimed_by=p_worker_id and status in ('claimed','running') returning * into result;
 if result.id is null then raise exception 'command_not_owned' using errcode='42501'; end if;
 return result;
end $$;

create or replace function ace_hunter.cancel_job_command(p_command_id uuid, p_actor text)
returns ace_hunter.job_commands language plpgsql security definer volatile
set search_path = ace_hunter, pg_catalog as $$
declare result ace_hunter.job_commands;
begin
 update ace_hunter.job_commands set status='cancelled', finished_at=now(), updated_at=now()
  where id=p_command_id and status='queued' returning * into result;
 if result.id is null then raise exception 'command_not_cancellable' using errcode='42501'; end if;
 insert into ace_hunter.ops_audit_log(actor,action,job_name,command_id) values(p_actor,'cancel',result.job_name,result.id);
 return result;
end $$;

create or replace function ace_hunter.requeue_job_command(p_command_id uuid, p_actor text)
returns ace_hunter.job_commands language plpgsql security definer volatile
set search_path = ace_hunter, pg_catalog as $$
declare result ace_hunter.job_commands;
begin
 update ace_hunter.job_commands set status='queued', claimed_by=null, lease_until=null, started_at=null, updated_at=now()
  where id=p_command_id and status in ('failed','partial') returning * into result;
 if result.id is null then raise exception 'command_not_requeueable' using errcode='42501'; end if;
 insert into ace_hunter.ops_audit_log(actor,action,job_name,command_id) values(p_actor,'requeue',result.job_name,result.id);
 return result;
end $$;

create or replace function ace_hunter.heartbeat_worker(p_worker_id text, p_executor text, p_capabilities text[], p_version text default null, p_metadata jsonb default '{}')
returns ace_hunter.worker_heartbeats language sql security definer volatile
set search_path = ace_hunter, pg_catalog as $$
 insert into ace_hunter.worker_heartbeats(worker_id,executor,capabilities,version,metadata,last_seen_at)
 values($1,$2,$3,$4,$5,now())
 on conflict(worker_id) do update set executor=excluded.executor, capabilities=excluded.capabilities, version=excluded.version, metadata=excluded.metadata, last_seen_at=now()
 returning *
$$;

revoke all on all functions in schema ace_hunter from public;
grant usage on schema ace_hunter to ace_hunter_ops, ace_hunter_github_runtime, ace_hunter_mac_worker;
grant select on ace_hunter.job_definitions to ace_hunter_ops;
grant execute on function ace_hunter.create_job_command(text,text,text,jsonb,text,timestamptz) to ace_hunter_ops, ace_hunter_github_runtime, ace_hunter_mac_worker;
grant execute on function ace_hunter.list_job_definitions() to ace_hunter_ops;
grant execute on function ace_hunter.record_ops_audit(text,text,text,uuid,jsonb), ace_hunter.list_ops_audit(integer) to ace_hunter_ops, ace_hunter_github_runtime, ace_hunter_mac_worker;
grant execute on function ace_hunter.claim_job_command(text,text,text[]) to ace_hunter_mac_worker, ace_hunter_github_runtime;
grant execute on function ace_hunter.start_job_command(uuid,text), ace_hunter.bind_job_run(uuid,text,uuid), ace_hunter.complete_job_command(uuid,text,text,text,text) to ace_hunter_mac_worker, ace_hunter_github_runtime;
create or replace function ace_hunter.x_lineage_ready(p_command_id uuid)
returns boolean language plpgsql security definer stable
set search_path = ace_hunter, pg_catalog as $$
declare child ace_hunter.job_commands; parent ace_hunter.job_commands; parent_id uuid; child_product text; parent_product text;
begin
 select * into child from ace_hunter.job_commands where id=p_command_id;
 if child.id is null then return false; end if;
 if child.job_name='collect_x_posts' then return true; end if;
 parent_id := nullif(child.parameters->'lineage'->>'parent_command_id','')::uuid;
 if parent_id is null then return false; end if;
 select * into parent from ace_hunter.job_commands where id=parent_id and status='succeeded';
 if parent.id is null then return false; end if;
 if (child.job_name='analyze_x_posts' and parent.job_name <> 'collect_x_posts')
    or (child.job_name='collect_x_comments' and parent.job_name <> 'analyze_x_posts') then return false; end if;
 child_product := coalesce(child.parameters->>'productId', child.parameters->>'product_id', child.parameters->'lineage'->>'parent_product_id');
 parent_product := coalesce(parent.parameters->>'productId', parent.parameters->>'product_id', parent.parameters->'lineage'->>'parent_product_id');
 return child_product is null or parent_product is null or child_product=parent_product;
end $$;
grant execute on function ace_hunter.x_lineage_ready(uuid) to ace_hunter_mac_worker, ace_hunter_github_runtime;
grant execute on function ace_hunter.cancel_job_command(uuid,text), ace_hunter.requeue_job_command(uuid,text) to ace_hunter_ops;
grant execute on function ace_hunter.heartbeat_worker(text,text,text[],text,jsonb) to ace_hunter_mac_worker, ace_hunter_github_runtime;

create or replace function ace_hunter.set_job_enabled(p_job_name text, p_enabled boolean, p_actor text)
returns ace_hunter.job_definitions language plpgsql security definer volatile
set search_path = ace_hunter, pg_catalog as $$
declare result ace_hunter.job_definitions;
begin
 update ace_hunter.job_definitions set enabled=p_enabled, paused_at=case when p_enabled then null else coalesce(paused_at,now()) end, updated_at=now() where name=p_job_name returning * into result;
 if result.name is null then raise exception 'unknown_job' using errcode='22023'; end if;
 insert into ace_hunter.ops_audit_log(actor,action,job_name,details) values(p_actor,case when p_enabled then 'enable' else 'pause' end,p_job_name,'{}');
 return result;
end $$;
create or replace function ace_hunter.retry_job_command(p_command_id uuid, p_actor text)
returns ace_hunter.job_commands language plpgsql security definer volatile
set search_path = ace_hunter, pg_catalog as $$
declare result ace_hunter.job_commands;
begin
 update ace_hunter.job_commands set status='queued',claimed_by=null,lease_until=null,started_at=null,finished_at=null,error_code=null,error_message=null,updated_at=now() where id=p_command_id and status in ('failed','partial') returning * into result;
 if result.id is null then raise exception 'command_not_requeueable' using errcode='42501'; end if;
 insert into ace_hunter.ops_audit_log(actor,action,job_name,command_id) values(p_actor,'retry',result.job_name,result.id);
 return result;
end $$;
grant execute on function ace_hunter.set_job_enabled(text,boolean,text), ace_hunter.retry_job_command(uuid,text) to ace_hunter_ops;
revoke all on function ace_hunter.set_job_enabled(text,boolean,text), ace_hunter.retry_job_command(uuid,text) from public;
