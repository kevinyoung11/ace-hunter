import { createHash } from "node:crypto";
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

/** Migration bookkeeping is infrastructure, not a business or control-plane table. */
export const migrationHistoryTable = "schema_migrations";

/**
 * Control-plane objects deliberately have their own manifest boundary.  Task 1
 * has no such objects yet; later versioned migrations extend this list without
 * weakening validation of the published business catalog.
 */
export const controlPlaneTables = [
  "job_definitions",
  "job_commands",
  "worker_heartbeats",
  "ops_audit_log",
] as const;

const businessRelationPredicate = `(table_object.relname <> 'schema_migrations' and table_object.relname not in (${controlPlaneTables.map((name) => `'${name}'`).join(",")}))`;

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
  "c:job_runs_retry_check:",
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

const expectedFingerprints = {
  columns: { count: 173, sha256: ["d6c8c9ce45bb99c23e5546b73573ff622ab757a936b4340cc68d7472d8150412", "59186033cd2b0d9301869975969507293ffa55df5e4c7a3acb52f94912a6d68f"] },
  indexes: { count: 21, sha256: "93dfd140a884d66ff84e949706426de9a46e58bc7dda87da6990f823246bdcd3" },
  checks: { count: 31, sha256: "23fee1b8e931fa2e427b0f39ae362dbe9047022fce4ac3176eb1d0b7dec0c23a" },
  foreignKeys: { count: 14, sha256: "99b1cbe3610ec64a5804b97d8143453041424a4ce33b5e0fc3c0af4ca36c066b" },
  constraints: { count: 56, sha256: "ef86719ee94544b3e1920933e7208b2cc2551fc40073fb3f2541211fa07f136f" },
  policies: { count: 9, sha256: "e6b84227f45078470630416e64cc3f7c0421600239a5e234588910143cbded89" },
  schemaAcl: { count: 3, sha256: "272e6f88097149d73e5b0a7de8190926445431de93d0828051fc8265ebd2b280" },
  tableAcl: { count: [99, 108], sha256: ["d2d3c8e945f73aceba1b001b6aec98a2f79e83ac0a2a0ecc20934fef3962f676", "6eb5e20cbfff79c8113d22a7ca799599ef95a54c18e04dc9563ebff9e686f543"] },
} as const;

function same(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function assertFingerprint(
  domain: keyof typeof expectedFingerprints,
  entries: readonly string[],
): void {
  const expected = expectedFingerprints[domain];
  const actualHash = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  const acceptedHashes: readonly string[] = typeof expected.sha256 === "string" ? [expected.sha256] : expected.sha256;
  const acceptedCounts: readonly number[] = typeof expected.count === "number" ? [expected.count] : expected.count;
  if (!acceptedCounts.includes(entries.length) || !acceptedHashes.includes(actualHash)) {
    throw new Error(
      `catalog preflight failed: ${domain} manifest mismatch ` +
        `(count=${entries.length}, sha256=${actualHash})`,
    );
  }
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

  const routines = await client.query<{ entry: string }>(
    `select routine.proname||'('||pg_get_function_identity_arguments(routine.oid)||')|'||
            pg_get_userbyid(routine.proowner)||'|'||language.lanname||'|'||
            routine.prokind::text||'|'||routine.prosecdef||'|'||routine.provolatile::text||'|'||
            routine.proleakproof||'|'||routine.proparallel::text||'|'||
            coalesce((
              select string_agg(
                coalesce(grantee.rolname,'PUBLIC')||':'||acl.privilege_type||':'||
                acl.is_grantable,',' order by coalesce(grantee.rolname,'PUBLIC'),
                acl.privilege_type
              )
                from aclexplode(coalesce(
                  routine.proacl,acldefault('f',routine.proowner)
                )) acl
                left join pg_roles grantee on grantee.oid=acl.grantee
            ),'<none>')||'|'||
            encode(sha256(convert_to(pg_get_functiondef(routine.oid),'UTF8')),'hex') entry
       from pg_proc routine
       join pg_namespace namespace_object on namespace_object.oid=routine.pronamespace
       join pg_language language on language.oid=routine.prolang
      where namespace_object.nspname='ace_hunter'
        and routine.proname not in ('claim_job_command','claim_job_command_by_id','start_job_command','bind_job_run','complete_job_command','cancel_job_command','requeue_job_command','heartbeat_worker','create_job_command','list_job_definitions','get_job_command','record_ops_audit','list_ops_audit','x_lineage_ready','set_job_enabled','retry_job_command')
      order by routine.proname,pg_get_function_identity_arguments(routine.oid)`,
  );
  if (routines.rows.length !== 0) {
    throw new Error("catalog preflight failed: routines manifest mismatch");
  }

  const customTypes = await client.query<{ entry: string }>(
    `select type_object.typname||'|'||pg_get_userbyid(type_object.typowner)||'|'||
            type_object.typtype::text||'|'||type_object.typcategory::text||'|'||
            type_object.typnotnull||'|'||
            coalesce(format_type(type_object.typbasetype,type_object.typtypmod),'<none>')||'|'||
            coalesce(type_object.typdefault,'<none>')||'|'||
            coalesce(collation_namespace.nspname||'.'||collation_object.collname,'<none>')||'|'||
            coalesce((
              select string_agg(
                coalesce(grantee.rolname,'PUBLIC')||':'||acl.privilege_type||':'||
                acl.is_grantable,',' order by coalesce(grantee.rolname,'PUBLIC'),
                acl.privilege_type
              )
                from aclexplode(type_object.typacl) acl
                left join pg_roles grantee on grantee.oid=acl.grantee
            ),'<none>') entry
       from pg_type type_object
       join pg_namespace namespace_object on namespace_object.oid=type_object.typnamespace
       left join pg_class related_relation on related_relation.oid=type_object.typrelid
       left join pg_collation collation_object on collation_object.oid=type_object.typcollation
       left join pg_namespace collation_namespace
         on collation_namespace.oid=collation_object.collnamespace
      where namespace_object.nspname='ace_hunter' and (
        type_object.typtype in ('d','e','r','m') or
        (type_object.typtype='c' and related_relation.relkind='c') or
        (type_object.typtype='b' and type_object.typrelid=0 and type_object.typelem=0)
      )
      order by type_object.typname`,
  );
  if (customTypes.rows.length !== 0) {
    throw new Error("catalog preflight failed: custom types manifest mismatch");
  }

  const userTriggers = await client.query<{ entry: string }>(
    `select table_object.relname||'|'||trigger_object.tgname||'|'||
            trigger_object.tgenabled::text||'|'||trigger_object.tgtype||'|'||
            pg_get_triggerdef(trigger_object.oid,false) entry
       from pg_trigger trigger_object
       join pg_class table_object on table_object.oid=trigger_object.tgrelid
       join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
      where namespace_object.nspname='ace_hunter' and not trigger_object.tgisinternal
      order by table_object.relname,trigger_object.tgname`,
  );
  if (userTriggers.rows.length !== 0) {
    throw new Error("catalog preflight failed: triggers manifest mismatch");
  }

  const userRules = await client.query<{ entry: string }>(
    `select table_object.relname||'|'||rule_object.rulename||'|'||
            rule_object.ev_type::text||'|'||rule_object.ev_enabled::text||'|'||
            rule_object.is_instead||'|'||
            encode(sha256(convert_to(pg_get_ruledef(rule_object.oid,false),'UTF8')),'hex') entry
       from pg_rewrite rule_object
       join pg_class table_object on table_object.oid=rule_object.ev_class
       join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
      where namespace_object.nspname='ace_hunter' and rule_object.rulename<>'_RETURN'
      order by table_object.relname,rule_object.rulename`,
  );
  if (userRules.rows.length !== 0) {
    throw new Error("catalog preflight failed: rules manifest mismatch");
  }

  const relations = await client.query<{
    relname: string;
    relkind: string;
    relpersistence: string;
    owner: string;
  }>(
    `select c.relname,c.relkind,c.relpersistence,pg_get_userbyid(c.relowner) owner
       from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='ace_hunter' and c.relname not in ('schema_migrations','job_definitions','job_commands','worker_heartbeats','ops_audit_log')
        and c.relkind in ('r','v','m','f','p') order by 1`,
  );
  if (relations.rows.length === 0) return "empty";

  const tables = relations.rows.filter((row) => row.relkind === "r");
  if (
    relations.rows.length !== businessTables.length ||
    !same(
      tables.map((row) => row.relname),
      businessTables,
    ) ||
    tables.some(
      (row) => row.owner !== "ace_hunter_owner" || row.relpersistence !== "p",
    )
  ) {
    throw new Error("catalog preflight failed: table manifest mismatch");
  }

  const controlRelations = await client.query<{ relname: string; owner: string }>(
    `select c.relname,pg_get_userbyid(c.relowner) owner
       from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='ace_hunter' and c.relkind='r' and c.relname = any($1::text[]) order by 1`,
    [controlPlaneTables],
  );
  if (
    controlRelations.rows.length !== 0 &&
    (controlRelations.rows.length !== controlPlaneTables.length ||
      controlRelations.rows.some((row) => row.owner !== "ace_hunter_owner"))
  ) throw new Error("catalog preflight failed: control-plane table manifest mismatch");

  const columns = await client.query<{ entry: string }>(
    `select table_object.relname||'|'||column_object.attnum||'|'||
            column_object.attname||'|'||format_type(
              column_object.atttypid,column_object.atttypmod
            )||'|'||
            coalesce(
              collation_namespace.nspname||'.'||collation_object.collname,'<none>'
            )||'|'||
            coalesce(nullif(column_object.attidentity::text,''),'<none>')||'|'||
            coalesce(nullif(column_object.attgenerated::text,''),'<none>')||'|'||
            case when column_object.attnotnull then 'NO' else 'YES' end||'|'||
            coalesce(
              pg_get_expr(column_default.adbin,column_default.adrelid,false),'<null>'
            ) entry
       from pg_attribute column_object
       join pg_class table_object on table_object.oid=column_object.attrelid
       join pg_namespace table_namespace on table_namespace.oid=table_object.relnamespace
       join pg_type type_object on type_object.oid=column_object.atttypid
       join pg_namespace type_namespace on type_namespace.oid=type_object.typnamespace
       left join pg_collation collation_object
         on collation_object.oid=column_object.attcollation
       left join pg_namespace collation_namespace
         on collation_namespace.oid=collation_object.collnamespace
       left join pg_attrdef column_default
         on column_default.adrelid=table_object.oid
        and column_default.adnum=column_object.attnum
      where table_namespace.nspname='ace_hunter' and table_object.relkind='r'
        and ${businessRelationPredicate}
        and column_object.attnum>0 and not column_object.attisdropped
      order by table_object.relname,column_object.attnum`,
  );
  const indexes = await client.query<{ entry: string }>(
    `select ci.relname||'|'||
            regexp_replace(pg_get_indexdef(i.indexrelid),'[[:space:]]+',' ','g') entry
       from pg_index i
       join pg_class ci on ci.oid=i.indexrelid
       join pg_class ct on ct.oid=i.indrelid
       join pg_namespace n on n.oid=ct.relnamespace
      where n.nspname='ace_hunter' and ct.relname not in ('schema_migrations','job_definitions','job_commands','worker_heartbeats','ops_audit_log')
      order by ci.relname`,
  );
  const checks = await client.query<{ entry: string }>(
    `select c.conname||'|'||
            regexp_replace(pg_get_expr(c.conbin,c.conrelid,false),'[[:space:]]+',' ','g') entry
       from pg_constraint c join pg_namespace n on n.oid=c.connamespace join pg_class table_object on table_object.oid=c.conrelid
      where n.nspname='ace_hunter' and c.contype='c' and table_object.relname not in ('schema_migrations','job_definitions','job_commands','worker_heartbeats','ops_audit_log')
      order by c.conname`,
  );
  const foreignKeys = await client.query<{ entry: string }>(
    `select c.conname||'|'||src.relname||'|'||
            string_agg(source_column.attname,',' order by local_key.ord)||'|'||
            target_namespace.nspname||'.'||target.relname||'|'||
            string_agg(target_column.attname,',' order by local_key.ord)||'|'||
            c.confdeltype::text||'|'||c.confupdtype::text||'|'||c.confmatchtype::text||'|'||
            c.condeferrable||'|'||c.condeferred||'|'||c.convalidated entry
       from pg_constraint c
       join pg_class src on src.oid=c.conrelid
       join pg_namespace source_namespace on source_namespace.oid=src.relnamespace
       join pg_class target on target.oid=c.confrelid
       join pg_namespace target_namespace on target_namespace.oid=target.relnamespace
       cross join lateral unnest(c.conkey) with ordinality local_key(attnum,ord)
       join pg_attribute source_column
         on source_column.attrelid=src.oid and source_column.attnum=local_key.attnum
       join pg_attribute target_column
         on target_column.attrelid=target.oid
        and target_column.attnum=c.confkey[local_key.ord]
      where source_namespace.nspname='ace_hunter' and c.contype='f' and src.relname not in ('schema_migrations','job_definitions','job_commands','worker_heartbeats','ops_audit_log')
      group by c.conname,src.relname,target_namespace.nspname,target.relname,
               c.confdeltype,c.confupdtype,c.confmatchtype,c.condeferrable,
               c.condeferred,c.convalidated
      order by c.conname`,
  );
  const constraints = await client.query<{
    conname: string;
    contype: string;
    confdeltype: string | null;
  }>(
    `select c.conname,c.contype,case when c.contype='f' then c.confdeltype::text end confdeltype
       from pg_constraint c join pg_namespace n on n.oid=c.connamespace join pg_class table_object on table_object.oid=c.conrelid
      where n.nspname='ace_hunter' and table_object.relname not in ('schema_migrations','job_definitions','job_commands','worker_heartbeats','ops_audit_log') order by c.conname`,
  );
  const constraintManifest = await client.query<{ entry: string }>(
    `select c.conname||'|'||c.contype::text||'|'||
            case when c.contype='f' then c.confupdtype::text else '<na>' end||'|'||
            case when c.contype='f' then c.confdeltype::text else '<na>' end||'|'||
            case when c.contype='f' then c.confmatchtype::text else '<na>' end||'|'||
            c.condeferrable||'|'||c.condeferred||'|'||c.convalidated entry
       from pg_constraint c join pg_namespace n on n.oid=c.connamespace join pg_class table_object on table_object.oid=c.conrelid
      where n.nspname='ace_hunter' and table_object.relname not in ('schema_migrations','job_definitions','job_commands','worker_heartbeats','ops_audit_log') order by c.conname`,
  );
  const policies = await client.query<{ entry: string }>(
    `select table_object.relname||'|'||policy.polname||'|'||policy.polpermissive||'|'||
            policy.polcmd::text||'|'||(
              select string_agg(role_name,',' order by role_name)
                from (
                  select case when role_oid=0 then 'PUBLIC' else role.rolname end role_name
                    from unnest(policy.polroles) role_oid
                    left join pg_roles role on role.oid=role_oid
                ) policy_roles
            )||'|'||
            coalesce(regexp_replace(pg_get_expr(policy.polqual,policy.polrelid,false),'[[:space:]]+',' ','g'),'<null>')||'|'||
            coalesce(regexp_replace(pg_get_expr(policy.polwithcheck,policy.polrelid,false),'[[:space:]]+',' ','g'),'<null>') entry
       from pg_policy policy
       join pg_class table_object on table_object.oid=policy.polrelid
       join pg_namespace n on n.oid=table_object.relnamespace
      where n.nspname='ace_hunter' and table_object.relname not in ('schema_migrations','job_definitions','job_commands','worker_heartbeats','ops_audit_log')
      order by table_object.relname,policy.polname`,
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
      where n.nspname='ace_hunter' and c.relkind='r' and c.relname not in ('schema_migrations','job_definitions','job_commands','worker_heartbeats','ops_audit_log')`,
  );

  const schemaAcl = await client.query<{ entry: string }>(
    `select n.nspname||'|'||coalesce(grantee.rolname,'PUBLIC')||'|'||
            acl.privilege_type||'|'||acl.is_grantable entry
       from pg_namespace n
       cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) acl
       left join pg_roles grantee on grantee.oid=acl.grantee
      where n.nspname='ace_hunter'
      order by 1`,
  );
  const tableAcl = await client.query<{ entry: string }>(
    `select table_object.relname||'|'||coalesce(grantee.rolname,'PUBLIC')||'|'||
            acl.privilege_type||'|'||acl.is_grantable entry
       from pg_class table_object
       join pg_namespace n on n.oid=table_object.relnamespace
       cross join lateral aclexplode(
         coalesce(table_object.relacl,acldefault('r',table_object.relowner))
       ) acl
       left join pg_roles grantee on grantee.oid=acl.grantee
      where n.nspname='ace_hunter' and table_object.relkind='r'
        and table_object.relname not in ('schema_migrations','job_definitions','job_commands','worker_heartbeats','ops_audit_log')
      order by 1`,
  );
  const columnAcl = await client.query<{ count: number }>(
    `select count(*)::int count
       from pg_attribute column_object
       join pg_class table_object on table_object.oid=column_object.attrelid
       join pg_namespace n on n.oid=table_object.relnamespace
      where n.nspname='ace_hunter' and table_object.relkind='r'
        and column_object.attnum>0 and not column_object.attisdropped
        and column_object.attacl is not null`,
  );
  const roleCapabilities = await client.query(
    `select rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,
            rolreplication,rolbypassrls
       from pg_roles where rolname like 'ace_hunter_%' order by rolname`,
  );
  const memberships = await client.query(
    `select granted.rolname granted_role,member.rolname member_role,
            edge.admin_option,
            coalesce((to_jsonb(edge)->>'inherit_option')::boolean,false) inherit_option,
            coalesce((to_jsonb(edge)->>'set_option')::boolean,true) set_option,
            grantor.rolname grantor_role,member.rolcreaterole member_createrole
       from pg_auth_members edge
       join pg_roles granted on granted.oid=edge.roleid
       join pg_roles member on member.oid=edge.member
       join pg_roles grantor on grantor.oid=edge.grantor
      where granted.rolname like 'ace_hunter_%' or member.rolname like 'ace_hunter_%'
      order by 1,2`,
  );
  const externalAceGrants = await client.query<{ count: number }>(
    `select (
       (select count(*) from pg_namespace namespace_object
          cross join lateral aclexplode(namespace_object.nspacl) acl
          left join pg_roles grantee on grantee.oid=acl.grantee
          left join pg_roles grantor on grantor.oid=acl.grantor
         where namespace_object.nspname<>'ace_hunter'
           and (grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%')
           and not (
             namespace_object.nspname='auth' and
             grantee.rolname='ace_hunter_owner' and acl.privilege_type='USAGE' and
             grantor.rolname not like 'ace_hunter_%'
           )) +
       (select count(*) from pg_class table_object
          join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
          cross join lateral aclexplode(table_object.relacl) acl
          left join pg_roles grantee on grantee.oid=acl.grantee
          left join pg_roles grantor on grantor.oid=acl.grantor
         where namespace_object.nspname<>'ace_hunter'
           and (grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%')
           and namespace_object.nspname!~'^pg_'
           and namespace_object.nspname<>'information_schema'
           and table_object.relkind in ('r','p','v','m','f','S')) +
       (select count(*) from pg_attribute column_object
          join pg_class table_object on table_object.oid=column_object.attrelid
          join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
          cross join lateral aclexplode(column_object.attacl) acl
          left join pg_roles grantee on grantee.oid=acl.grantee
          left join pg_roles grantor on grantor.oid=acl.grantor
         where column_object.attnum>0 and not column_object.attisdropped
           and namespace_object.nspname<>'ace_hunter'
           and (grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%')
           and not (
             namespace_object.nspname='auth' and table_object.relname='users' and
             column_object.attname='id' and grantee.rolname='ace_hunter_owner' and
             acl.privilege_type='REFERENCES' and grantor.rolname not like 'ace_hunter_%'
           )) +
       (select count(*) from pg_namespace namespace_object
          join pg_roles owner_role on owner_role.oid=namespace_object.nspowner
         where owner_role.rolname like 'ace_hunter_%'
           and namespace_object.nspname<>'ace_hunter'
           and namespace_object.nspname!~'^pg_'
           and namespace_object.nspname<>'information_schema') +
       (select count(*) from pg_class object
          join pg_namespace namespace_object on namespace_object.oid=object.relnamespace
          join pg_roles owner_role on owner_role.oid=object.relowner
         where owner_role.rolname like 'ace_hunter_%'
           and namespace_object.nspname<>'ace_hunter'
           and namespace_object.nspname!~'^pg_'
           and namespace_object.nspname<>'information_schema'
           and object.relkind in ('r','p','v','m','f','S')) +
       (select count(*) from pg_namespace namespace_object
          cross join lateral aclexplode(namespace_object.nspacl) acl
          join pg_roles grantor on grantor.oid=acl.grantor
         where namespace_object.nspname<>'ace_hunter' and acl.grantee=0
           and grantor.rolname like 'ace_hunter_%') +
       (select count(*) from pg_class table_object
          join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
          cross join lateral aclexplode(table_object.relacl) acl
          join pg_roles grantor on grantor.oid=acl.grantor
         where namespace_object.nspname<>'ace_hunter' and acl.grantee=0
           and grantor.rolname like 'ace_hunter_%') +
       (select count(*) from pg_attribute column_object
          join pg_class table_object on table_object.oid=column_object.attrelid
          join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
          cross join lateral aclexplode(column_object.attacl) acl
          join pg_roles grantor on grantor.oid=acl.grantor
         where namespace_object.nspname<>'ace_hunter' and acl.grantee=0
           and grantor.rolname like 'ace_hunter_%') +
       (select count(*) from pg_proc routine
          join pg_namespace namespace_object on namespace_object.oid=routine.pronamespace
          join pg_roles owner_role on owner_role.oid=routine.proowner
         where namespace_object.nspname<>'ace_hunter'
           and namespace_object.nspname!~'^pg_'
           and namespace_object.nspname<>'information_schema'
           and owner_role.rolname like 'ace_hunter_%') +
       (select count(*) from pg_proc routine
          join pg_namespace namespace_object on namespace_object.oid=routine.pronamespace
          cross join lateral aclexplode(routine.proacl) acl
          left join pg_roles grantee on grantee.oid=acl.grantee
          left join pg_roles grantor on grantor.oid=acl.grantor
         where namespace_object.nspname<>'ace_hunter'
           and namespace_object.nspname!~'^pg_'
           and namespace_object.nspname<>'information_schema'
           and (grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%')) +
       (select count(*) from pg_type type_object
          join pg_namespace namespace_object on namespace_object.oid=type_object.typnamespace
          join pg_roles owner_role on owner_role.oid=type_object.typowner
         where namespace_object.nspname<>'ace_hunter'
           and namespace_object.nspname!~'^pg_'
           and namespace_object.nspname<>'information_schema'
           and owner_role.rolname like 'ace_hunter_%') +
       (select count(*) from pg_type type_object
          join pg_namespace namespace_object on namespace_object.oid=type_object.typnamespace
          cross join lateral aclexplode(type_object.typacl) acl
          left join pg_roles grantee on grantee.oid=acl.grantee
          left join pg_roles grantor on grantor.oid=acl.grantor
         where namespace_object.nspname<>'ace_hunter'
           and namespace_object.nspname!~'^pg_'
           and namespace_object.nspname<>'information_schema'
           and (grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%')) +
       (select count(*) from pg_database database_object
          join pg_roles owner_role on owner_role.oid=database_object.datdba
         where owner_role.rolname like 'ace_hunter_%') +
       (select count(*) from pg_database database_object
          cross join lateral aclexplode(database_object.datacl) acl
          left join pg_roles grantee on grantee.oid=acl.grantee
          left join pg_roles grantor on grantor.oid=acl.grantor
         where grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%') +
       (select count(*) from pg_default_acl defaults
          join pg_roles owner_role on owner_role.oid=defaults.defaclrole
         where owner_role.rolname like 'ace_hunter_%') +
       (select count(*) from pg_default_acl defaults
          cross join lateral aclexplode(defaults.defaclacl) acl
          left join pg_roles grantee on grantee.oid=acl.grantee
          left join pg_roles grantor on grantor.oid=acl.grantor
         where grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%') +
       (select count(*) from pg_tablespace tablespace_object
          join pg_roles owner_role on owner_role.oid=tablespace_object.spcowner
         where owner_role.rolname like 'ace_hunter_%') +
       (select count(*) from pg_tablespace tablespace_object
          cross join lateral aclexplode(tablespace_object.spcacl) acl
          left join pg_roles grantee on grantee.oid=acl.grantee
          left join pg_roles grantor on grantor.oid=acl.grantor
         where grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%')
     )::int count`,
  );
  const authAceAcl = await client.query<{ entry: string }>(
    `select 'schema|auth|'||grantee.rolname||'|'||acl.privilege_type||'|'||
            acl.is_grantable entry
       from pg_namespace namespace_object
       cross join lateral aclexplode(coalesce(
         namespace_object.nspacl,acldefault('n',namespace_object.nspowner)
       )) acl
       join pg_roles grantee on grantee.oid=acl.grantee
      where namespace_object.nspname='auth' and grantee.rolname like 'ace_hunter_%'
     union all
     select 'table|auth.'||table_object.relname||'|'||grantee.rolname||'|'||
            acl.privilege_type||'|'||acl.is_grantable entry
       from pg_class table_object
       join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
       cross join lateral aclexplode(coalesce(
         table_object.relacl,acldefault('r',table_object.relowner)
       )) acl
       join pg_roles grantee on grantee.oid=acl.grantee
      where namespace_object.nspname='auth' and grantee.rolname like 'ace_hunter_%'
     union all
     select 'column|auth.'||table_object.relname||'.'||column_object.attname||'|'||
            grantee.rolname||'|'||acl.privilege_type||'|'||acl.is_grantable entry
       from pg_attribute column_object
       join pg_class table_object on table_object.oid=column_object.attrelid
       join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
       cross join lateral aclexplode(column_object.attacl) acl
       join pg_roles grantee on grantee.oid=acl.grantee
      where namespace_object.nspname='auth' and grantee.rolname like 'ace_hunter_%'
      order by 1`,
  );

  if (
    !same(
      constraints.rows.map((row) => `${row.contype}:${row.conname}:${row.confdeltype ?? ""}`),
      expectedConstraints,
    )
  ) {
    throw new Error("catalog preflight failed: constraint identity mismatch");
  }
  if (
    security.rows.length !== businessTables.length ||
    security.rows.some(
      (row) =>
        !row.relrowsecurity ||
        !row.relforcerowsecurity ||
        row.public_select ||
        !row.runtime_crud,
    )
  ) {
    throw new Error("catalog preflight failed: RLS security mismatch");
  }
  if (columnAcl.rows[0]?.count !== 0) {
    throw new Error("catalog preflight failed: column ACL mismatch");
  }
  if (externalAceGrants.rows[0]?.count !== 0) {
    throw new Error("catalog preflight failed: external Ace ACL mismatch");
  }
  const authAclEntries = authAceAcl.rows.map((row) => row.entry);
  if (
    JSON.stringify(authAclEntries) !== JSON.stringify([]) &&
    JSON.stringify(authAclEntries) !== JSON.stringify([
      "column|auth.users.id|ace_hunter_owner|REFERENCES|false",
      "schema|auth|ace_hunter_owner|USAGE|false",
    ])
  ) {
    throw new Error("catalog preflight failed: auth ACL mismatch");
  }
  const expectedRoleCapabilities = [
    { rolname: "ace_hunter_migrator", rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolreplication: false, rolbypassrls: false },
    { rolname: "ace_hunter_owner", rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolreplication: false, rolbypassrls: false },
  ];
  const runtimeCapabilities = roleCapabilities.rows.find(
    (row) => row.rolname === "ace_hunter_runtime",
  );
  const expectedControlRoles = ["ace_hunter_ops", "ace_hunter_github_runtime", "ace_hunter_mac_worker"];
  const hasControlPlane = controlRelations.rows.length === controlPlaneTables.length;
  if (
    !([3, 6] as const).includes(roleCapabilities.rows.length as 3 | 6) ||
    JSON.stringify(roleCapabilities.rows.filter((row) => ["ace_hunter_migrator", "ace_hunter_owner"].includes(row.rolname))) !==
      JSON.stringify(expectedRoleCapabilities) ||
    !runtimeCapabilities ||
    runtimeCapabilities.rolsuper ||
    runtimeCapabilities.rolcreatedb ||
    runtimeCapabilities.rolcreaterole ||
    runtimeCapabilities.rolinherit ||
    runtimeCapabilities.rolreplication ||
    runtimeCapabilities.rolbypassrls
  ) {
    throw new Error("catalog preflight failed: role capabilities mismatch");
  }
  if (hasControlPlane && expectedControlRoles.some((name) => !roleCapabilities.rows.some((row) => row.rolname === name))) {
    throw new Error("catalog preflight failed: control-plane role capabilities mismatch");
  }
  const functionalMemberships = memberships.rows.filter((row) => row.set_option || row.inherit_option);
  const creatorAdminMemberships = memberships.rows.filter((row) => row.admin_option && !row.set_option && !row.inherit_option);
  const validCreatorMemberships = creatorAdminMemberships.length === 0 || (
    creatorAdminMemberships.length === 3 &&
    new Set(creatorAdminMemberships.map((row) => row.member_role)).size === 1 &&
    !String(creatorAdminMemberships[0]?.member_role).startsWith("ace_hunter_") &&
    creatorAdminMemberships.every((row) => row.member_createrole === true && !String(row.grantor_role).startsWith("ace_hunter_")) &&
    JSON.stringify(creatorAdminMemberships.map((row) => row.granted_role).sort()) ===
      JSON.stringify(["ace_hunter_migrator", "ace_hunter_owner", "ace_hunter_runtime"])
  );
  if (JSON.stringify(functionalMemberships) !== JSON.stringify([{
    granted_role: "ace_hunter_owner", member_role: "ace_hunter_migrator",
    admin_option: false, inherit_option: false, set_option: true,
    grantor_role: functionalMemberships[0]?.grantor_role,
    member_createrole: false,
  }]) || !validCreatorMemberships) {
    throw new Error("catalog preflight failed: role membership mismatch");
  }
  assertFingerprint("columns", columns.rows.map((row) => row.entry));
  assertFingerprint("indexes", indexes.rows.map((row) => row.entry));
  assertFingerprint("checks", checks.rows.map((row) => row.entry));
  assertFingerprint("foreignKeys", foreignKeys.rows.map((row) => row.entry));
  assertFingerprint("constraints", constraintManifest.rows.map((row) => row.entry));
  assertFingerprint("policies", policies.rows.map((row) => row.entry));
  assertFingerprint("schemaAcl", schemaAcl.rows.map((row) => row.entry));
  assertFingerprint("tableAcl", tableAcl.rows.map((row) => row.entry));
  return "complete";
}

export async function assertRuntimeActivationInvariant(
  client: PoolClient,
): Promise<void> {
  const state = await assertCatalogIsAbsentOrComplete(client);
  if (state !== "complete") {
    throw new Error("runtime activation invariant failed: catalog is not complete");
  }
  const runtime = await client.query<{ rolcanlogin: boolean }>(
    "select rolcanlogin from pg_roles where rolname='ace_hunter_runtime'",
  );
  if (runtime.rows[0]?.rolcanlogin !== true) {
    throw new Error("runtime activation invariant failed: runtime role is not LOGIN");
  }
}
