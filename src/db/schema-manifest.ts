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

const expectedFingerprints = {
  columns: { count: 172, sha256: "439882e91e377d32b119a9d72f1a675702f23226d4b03b6f078a4d36b9e7d669" },
  indexes: { count: 21, sha256: "93dfd140a884d66ff84e949706426de9a46e58bc7dda87da6990f823246bdcd3" },
  checks: { count: 30, sha256: "6e91c757967f330a97a7e02a343fd4a850237a1a9c5f42573b0bee11b98e8371" },
  foreignKeys: { count: 14, sha256: "99b1cbe3610ec64a5804b97d8143453041424a4ce33b5e0fc3c0af4ca36c066b" },
  constraints: { count: 55, sha256: "1a80ec06fb10a1d71053beb4dcfec424b1a3d7518d6e75e9f086dbfa497af697" },
  policies: { count: 9, sha256: "e6b84227f45078470630416e64cc3f7c0421600239a5e234588910143cbded89" },
  schemaAcl: { count: 3, sha256: "272e6f88097149d73e5b0a7de8190926445431de93d0828051fc8265ebd2b280" },
  tableAcl: { count: 99, sha256: "d2d3c8e945f73aceba1b001b6aec98a2f79e83ac0a2a0ecc20934fef3962f676" },
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
  if (entries.length !== expected.count || actualHash !== expected.sha256) {
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

  const relations = await client.query<{
    relname: string;
    relkind: string;
    relpersistence: string;
    owner: string;
  }>(
    `select c.relname,c.relkind,c.relpersistence,pg_get_userbyid(c.relowner) owner
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
    tables.some(
      (row) => row.owner !== "ace_hunter_owner" || row.relpersistence !== "p",
    )
  ) {
    throw new Error("catalog preflight failed: table manifest mismatch");
  }

  const columns = await client.query<{ entry: string }>(
    `select table_object.relname||'|'||column_object.attnum||'|'||
            column_object.attname||'|'||format_type(
              column_object.atttypid,column_object.atttypmod
            )||'|'||
            coalesce(
              collation_namespace.nspname||'.'||collation_object.collname,'<none>'
            )||'|'||
            coalesce(nullif(column_object.attidentity,''),'<none>')||'|'||
            coalesce(nullif(column_object.attgenerated,''),'<none>')||'|'||
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
      where n.nspname='ace_hunter'
      order by ci.relname`,
  );
  const checks = await client.query<{ entry: string }>(
    `select c.conname||'|'||
            regexp_replace(pg_get_expr(c.conbin,c.conrelid,false),'[[:space:]]+',' ','g') entry
       from pg_constraint c join pg_namespace n on n.oid=c.connamespace
      where n.nspname='ace_hunter' and c.contype='c'
      order by c.conname`,
  );
  const foreignKeys = await client.query<{ entry: string }>(
    `select c.conname||'|'||src.relname||'|'||
            string_agg(source_column.attname,',' order by local_key.ord)||'|'||
            target_namespace.nspname||'.'||target.relname||'|'||
            string_agg(target_column.attname,',' order by local_key.ord)||'|'||
            c.confdeltype||'|'||c.confupdtype||'|'||c.confmatchtype||'|'||
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
      where source_namespace.nspname='ace_hunter' and c.contype='f'
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
       from pg_constraint c join pg_namespace n on n.oid=c.connamespace
      where n.nspname='ace_hunter' order by c.conname`,
  );
  const constraintManifest = await client.query<{ entry: string }>(
    `select c.conname||'|'||c.contype||'|'||
            case when c.contype='f' then c.confupdtype::text else '<na>' end||'|'||
            case when c.contype='f' then c.confdeltype::text else '<na>' end||'|'||
            case when c.contype='f' then c.confmatchtype::text else '<na>' end||'|'||
            c.condeferrable||'|'||c.condeferred||'|'||c.convalidated entry
       from pg_constraint c join pg_namespace n on n.oid=c.connamespace
      where n.nspname='ace_hunter' order by c.conname`,
  );
  const policies = await client.query<{ entry: string }>(
    `select table_object.relname||'|'||policy.polname||'|'||policy.polpermissive||'|'||
            policy.polcmd||'|'||(
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
      where n.nspname='ace_hunter'
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
      where n.nspname='ace_hunter' and c.relkind='r'`,
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
    `select granted.rolname granted_role,member.rolname member_role
       from pg_auth_members edge
       join pg_roles granted on granted.oid=edge.roleid
       join pg_roles member on member.oid=edge.member
      where granted.rolname like 'ace_hunter_%' or member.rolname like 'ace_hunter_%'
      order by 1,2`,
  );
  const externalAceGrants = await client.query<{ count: number }>(
    `select (
       (select count(*) from pg_namespace namespace_object
          cross join lateral aclexplode(coalesce(
            namespace_object.nspacl,acldefault('n',namespace_object.nspowner)
          )) acl
          join pg_roles grantee on grantee.oid=acl.grantee
         where grantee.rolname in (
           'ace_hunter_owner','ace_hunter_migrator','ace_hunter_runtime'
         ) and namespace_object.nspname<>'ace_hunter'
           and not (
             namespace_object.nspname='auth' and
             grantee.rolname='ace_hunter_owner' and acl.privilege_type='USAGE'
           )) +
       (select count(*) from pg_class table_object
          join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
          cross join lateral aclexplode(coalesce(
            table_object.relacl,acldefault('r',table_object.relowner)
          )) acl
          join pg_roles grantee on grantee.oid=acl.grantee
         where grantee.rolname in (
           'ace_hunter_owner','ace_hunter_migrator','ace_hunter_runtime'
         ) and namespace_object.nspname<>'ace_hunter'
           and namespace_object.nspname!~'^pg_'
           and namespace_object.nspname<>'information_schema'
           and table_object.relkind in ('r','p','v','m','f','S')) +
       (select count(*) from pg_attribute column_object
          join pg_class table_object on table_object.oid=column_object.attrelid
          join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
          cross join lateral aclexplode(column_object.attacl) acl
          join pg_roles grantee on grantee.oid=acl.grantee
         where column_object.attnum>0 and not column_object.attisdropped
           and grantee.rolname in (
             'ace_hunter_owner','ace_hunter_migrator','ace_hunter_runtime'
           ) and namespace_object.nspname<>'ace_hunter'
           and not (
             namespace_object.nspname='auth' and table_object.relname='users' and
             column_object.attname='id' and grantee.rolname='ace_hunter_owner' and
             acl.privilege_type='REFERENCES'
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
         where database_object.datname=current_database()
           and owner_role.rolname like 'ace_hunter_%') +
       (select count(*) from pg_database database_object
          cross join lateral aclexplode(database_object.datacl) acl
          left join pg_roles grantee on grantee.oid=acl.grantee
          left join pg_roles grantor on grantor.oid=acl.grantor
         where database_object.datname=current_database()
           and (grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%'))
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
  if (
    JSON.stringify(authAceAcl.rows.map((row) => row.entry)) !==
    JSON.stringify([
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
  if (
    roleCapabilities.rows.length !== 3 ||
    JSON.stringify(roleCapabilities.rows.slice(0, 2)) !==
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
  if (
    JSON.stringify(memberships.rows) !==
    JSON.stringify([{ granted_role: "ace_hunter_owner", member_role: "ace_hunter_migrator" }])
  ) {
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
