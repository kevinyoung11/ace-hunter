import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { loadAdminConfig } from "../src/config/load-config.js";

export type Catalog = Record<string, Array<Record<string, unknown>>>;
type Queryable = { query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };

const ACE_ROLES = ["ace_hunter_owner", "ace_hunter_migrator", "ace_hunter_runtime", "ace_hunter_ops", "ace_hunter_github_runtime", "ace_hunter_mac_worker"] as const;
const EXPECTED_ROLES: Record<string, Record<string, unknown>> = {
  ace_hunter_owner: role("ace_hunter_owner", false),
  ace_hunter_migrator: role("ace_hunter_migrator", true),
  ace_hunter_runtime: role("ace_hunter_runtime", true),
  ace_hunter_ops: role("ace_hunter_ops", false),
  ace_hunter_github_runtime: role("ace_hunter_github_runtime", true),
  ace_hunter_mac_worker: role("ace_hunter_mac_worker", true),
};

function role(rolname: string, rolcanlogin: boolean): Record<string, unknown> {
  return { rolname, rolsuper: false, rolinherit: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin, rolreplication: false, rolbypassrls: false };
}

export const CATALOG_SQL = `select jsonb_build_object(
  'schemas', coalesce((select jsonb_agg(to_jsonb(x) order by name) from (select nspname name,pg_get_userbyid(nspowner) owner from pg_namespace where nspname not in ('ace_hunter','pg_catalog','information_schema','pg_toast') and nspname not like 'pg_temp_%' and nspname not like 'pg_toast_temp_%') x),'[]'::jsonb),
  'relations', coalesce((select jsonb_agg(to_jsonb(x) order by schema_name,relation_name) from (select n.nspname schema_name,c.relname relation_name,c.relkind,pg_get_userbyid(c.relowner) owner,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not in ('ace_hunter','pg_catalog','information_schema','pg_toast') and n.nspname not like 'pg_temp_%' and n.nspname not like 'pg_toast_temp_%') x),'[]'::jsonb),
  'columns', coalesce((select jsonb_agg(to_jsonb(x) order by table_schema,table_name,ordinal_position) from (select table_schema,table_name,ordinal_position,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema not in ('ace_hunter','pg_catalog','information_schema') and table_schema not like 'pg_temp_%' and table_schema not like 'pg_toast_temp_%') x),'[]'::jsonb),
  'constraints', coalesce((select jsonb_agg(to_jsonb(x) order by schema_name,table_name,name) from (select n.nspname schema_name,c.relname table_name,k.conname name,pg_get_constraintdef(k.oid,true) definition from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname not in ('ace_hunter','pg_catalog','information_schema','pg_toast')) x),'[]'::jsonb),
  'indexes', coalesce((select jsonb_agg(to_jsonb(x) order by schemaname,indexname) from (select schemaname,indexname,indexdef from pg_indexes where schemaname not in ('ace_hunter','pg_catalog','information_schema')) x),'[]'::jsonb),
  'policies', coalesce((select jsonb_agg(to_jsonb(x) order by schemaname,tablename,policyname) from (select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname<>'ace_hunter') x),'[]'::jsonb),
  'routines', coalesce((select jsonb_agg(to_jsonb(x) order by routine_schema,routine_name,specific_name) from (select routine_schema,routine_name,specific_name,routine_type,data_type,external_language from information_schema.routines where routine_schema not in ('ace_hunter','pg_catalog','information_schema')) x),'[]'::jsonb),
  'triggers', coalesce((select jsonb_agg(to_jsonb(x) order by trigger_schema,event_object_table,trigger_name,event_manipulation) from (select trigger_schema,event_object_table,trigger_name,event_manipulation,action_statement from information_schema.triggers where trigger_schema<>'ace_hunter') x),'[]'::jsonb),
  'types', coalesce((select jsonb_agg(to_jsonb(x) order by schema_name,type_name,label) from (select n.nspname schema_name,t.typname type_name,e.enumlabel label from pg_type t join pg_namespace n on n.oid=t.typnamespace left join pg_enum e on e.enumtypid=t.oid where n.nspname not in ('ace_hunter','pg_catalog','information_schema','pg_toast')) x),'[]'::jsonb),
  'extensions', coalesce((select jsonb_agg(to_jsonb(x) order by name) from (select e.extname name,e.extversion version,n.nspname schema_name,pg_get_userbyid(e.extowner) owner from pg_extension e join pg_namespace n on n.oid=e.extnamespace) x),'[]'::jsonb),
  'roles', coalesce((select jsonb_agg(to_jsonb(x) order by rolname) from (select rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls from pg_roles) x),'[]'::jsonb),
  'memberships', coalesce((select jsonb_agg(to_jsonb(x) order by role_name,member_name) from (select r.rolname role_name,m.rolname member_name,g.rolname grantor_name,a.admin_option,coalesce((to_jsonb(a)->>'inherit_option')::boolean,false) inherit_option,coalesce((to_jsonb(a)->>'set_option')::boolean,true) set_option from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member join pg_roles g on g.oid=a.grantor) x),'[]'::jsonb),
  'session_identity', coalesce((select jsonb_agg(to_jsonb(x)) from (select current_user name) x),'[]'::jsonb),
  'schema_grants', coalesce((select jsonb_agg(to_jsonb(x) order by schema_name,grantee,privilege) from (select n.nspname schema_name,coalesce(g.rolname,'PUBLIC') grantee,a.privilege_type privilege,a.is_grantable from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a left join pg_roles g on g.oid=a.grantee where n.nspname not in ('ace_hunter','pg_catalog','information_schema','pg_toast')) x),'[]'::jsonb),
  'relation_grants', coalesce((select jsonb_agg(to_jsonb(x) order by schema_name,relation_name,grantee,privilege) from (select n.nspname schema_name,c.relname relation_name,coalesce(g.rolname,'PUBLIC') grantee,a.privilege_type privilege,a.is_grantable from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join lateral aclexplode(coalesce(c.relacl,acldefault(case when c.relkind='S' then 's'::"char" else 'r'::"char" end,c.relowner))) a left join pg_roles g on g.oid=a.grantee where n.nspname not in ('ace_hunter','pg_catalog','information_schema','pg_toast') and c.relkind in ('r','p','v','m','f','S')) x),'[]'::jsonb),
  'column_grants', coalesce((select jsonb_agg(to_jsonb(x) order by schema_name,relation_name,column_name,grantee,privilege) from (select n.nspname schema_name,c.relname relation_name,col.attname column_name,coalesce(g.rolname,'PUBLIC') grantee,a.privilege_type privilege,a.is_grantable from pg_attribute col join pg_class c on c.oid=col.attrelid join pg_namespace n on n.oid=c.relnamespace cross join lateral aclexplode(col.attacl) a left join pg_roles g on g.oid=a.grantee where col.attnum>0 and not col.attisdropped and col.attacl is not null and n.nspname not in ('ace_hunter','pg_catalog','information_schema','pg_toast')) x),'[]'::jsonb),
  'database_grants', coalesce((select jsonb_agg(to_jsonb(x) order by database_name,grantee,privilege) from (select d.datname database_name,coalesce(g.rolname,'PUBLIC') grantee,a.privilege_type privilege,a.is_grantable from pg_database d cross join lateral aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a left join pg_roles g on g.oid=a.grantee) x),'[]'::jsonb),
  'default_grants', coalesce((select jsonb_agg(to_jsonb(x) order by owner_name,schema_name,object_type,grantee,privilege) from (select o.rolname owner_name,coalesce(n.nspname,'') schema_name,d.defaclobjtype object_type,coalesce(g.rolname,'PUBLIC') grantee,a.privilege_type privilege,a.is_grantable from pg_default_acl d join pg_roles o on o.oid=d.defaclrole left join pg_namespace n on n.oid=d.defaclnamespace cross join lateral aclexplode(d.defaclacl) a left join pg_roles g on g.oid=a.grantee) x),'[]'::jsonb)
) catalog`;

export async function captureAdminCatalog(pool: Queryable): Promise<Catalog> {
  // The single JSON aggregation is fast on a disposable PostgreSQL database,
  // but can monopolize a Supabase catalog with many extension objects. Query
  // each complete relation separately and canonicalize client-side.
  const split = splitCatalogQueries(CATALOG_SQL);
  if (split === null) {
    const result = await pool.query(CATALOG_SQL);
    return result.rows[0]?.catalog as Catalog;
  }
  const catalog: Catalog = {};
  for (const [name, sql] of split) catalog[name] = (await pool.query(sql)).rows;
  return catalog;
}

export function splitCatalogQueries(sql: string): Array<[string, string]> | null {
  const body = sql.match(/^select jsonb_build_object\(([\s\S]*)\) catalog$/u)?.[1];
  if (!body) return null;
  const entries: string[] = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === "'") {
      if (quoted && body[index + 1] === "'") { index += 1; continue; }
      quoted = !quoted;
    } else if (!quoted && character === "(") depth += 1;
    else if (!quoted && character === ")") depth -= 1;
    else if (!quoted && character === "," && depth === 0) {
      entries.push(body.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(body.slice(start));
  if (entries.length % 2 !== 0) return null;
  const queries: Array<[string, string]> = [];
  for (let index = 0; index < entries.length; index += 2) {
    const name = entries[index].trim().match(/^'([a-z_]+)'$/u)?.[1];
    const trimmed = entries[index + 1].trim();
    const marker = " from (";
    const innerStart = trimmed.indexOf(marker);
    const suffix = ") x),'[]'::jsonb)";
    const innerEnd = trimmed.lastIndexOf(suffix);
    if (!name || innerStart < 0 || innerEnd <= innerStart) return null;
    const query = trimmed.slice(innerStart + marker.length, innerEnd);
    if (!query.startsWith("select ")) return null;
    queries.push([name, query]);
  }
  return queries;
}

export function canonicalizeCatalog(catalog: Catalog): Catalog {
  return Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => [key, [...rows].sort((a, b) => JSON.stringify(sortObject(a)).localeCompare(JSON.stringify(sortObject(b)))).map(sortObject)]));
}

function sortObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

export function applyExactBootstrapDelta(before: Catalog): Catalog {
  const expected = structuredClone(before);
  const existingCoreMembership = (before.memberships ?? []).find((row) => row.role_name === "ace_hunter_owner" && row.member_name === "ace_hunter_migrator");
  const bootstrapIdentity = existingCoreMembership?.grantor_name ?? before.session_identity?.[0]?.name;
  if (typeof bootstrapIdentity !== "string") throw new Error("administrator_catalog_identity_missing");
  expected.roles = [...(expected.roles ?? []).filter((row) => !ACE_ROLES.includes(String(row.rolname) as typeof ACE_ROLES[number])), ...ACE_ROLES.map((name) => ({ ...EXPECTED_ROLES[name] }))];
  expected.memberships = [...(expected.memberships ?? []).filter((row) => !(isAce(row.role_name) && isAce(row.member_name))), {
    role_name: "ace_hunter_owner", member_name: "ace_hunter_migrator", grantor_name: bootstrapIdentity,
    admin_option: false, inherit_option: false, set_option: true,
  }];
  expected.schema_grants = [...(expected.schema_grants ?? []).filter((row) => !isAce(row.grantee)), { schema_name: "auth", grantee: "ace_hunter_owner", privilege: "USAGE", is_grantable: false }];
  expected.relation_grants = (expected.relation_grants ?? []).filter((row) => !isAce(row.grantee));
  expected.column_grants = [...(expected.column_grants ?? []).filter((row) => !isAce(row.grantee)), { schema_name: "auth", relation_name: "users", column_name: "id", grantee: "ace_hunter_owner", privilege: "REFERENCES", is_grantable: false }];
  expected.database_grants = (expected.database_grants ?? []).filter((row) => !isAce(row.grantee));
  expected.default_grants = (expected.default_grants ?? []).filter((row) => !isAce(row.grantee) && !isAce(row.owner_name));
  return expected;
}

function isAce(value: unknown): boolean { return typeof value === "string" && value.startsWith("ace_hunter_"); }

export function assertCatalogEqualExceptAceRoles(before: Catalog, after: Catalog): void {
  for (const catalog of [before, after]) {
    if ((catalog.roles ?? []).some((row) => isAce(row.rolname) && !ACE_ROLES.includes(String(row.rolname) as typeof ACE_ROLES[number]))) {
      throw new Error("administrator_catalog_changed_outside_exact_reviewed_bootstrap_delta");
    }
  }
  const expected = canonicalizeCatalog(applyExactBootstrapDelta(before));
  const expectedWithoutDelegatedAuth = canonicalizeCatalog({
    ...applyExactBootstrapDelta(before),
    schema_grants: (applyExactBootstrapDelta(before).schema_grants ?? []).filter((row) => !isAce(row.grantee)),
    column_grants: (applyExactBootstrapDelta(before).column_grants ?? []).filter((row) => !isAce(row.grantee)),
  });
  const beforeMembershipKeys = new Set((before.memberships ?? []).map((row) => JSON.stringify(sortObject(row))));
  const sessionIdentity = after.session_identity?.[0]?.name;
  const creatorMemberships = (after.memberships ?? []).filter((row) =>
    !beforeMembershipKeys.has(JSON.stringify(sortObject(row))) &&
    ACE_ROLES.includes(String(row.role_name) as typeof ACE_ROLES[number]) &&
    !isAce(row.member_name) && row.member_name === sessionIdentity && !isAce(row.grantor_name) &&
    row.admin_option === true && row.inherit_option === false && row.set_option === false,
  );
  const validCreatorMemberships = creatorMemberships.length === 0 || (
    creatorMemberships.length === 3 &&
    new Set(creatorMemberships.map((row) => row.member_name)).size === 1 &&
    new Set(creatorMemberships.map((row) => row.role_name)).size === 3 && typeof sessionIdentity === "string"
  );
  if (!validCreatorMemberships) throw new Error("administrator_catalog_changed_outside_exact_reviewed_bootstrap_delta");
  const actual = canonicalizeCatalog({
    ...after,
    memberships: (after.memberships ?? []).filter((row) => !creatorMemberships.includes(row)),
  });
  if (JSON.stringify(expected) !== JSON.stringify(actual) && JSON.stringify(expectedWithoutDelegatedAuth) !== JSON.stringify(actual)) {
    throw new Error("administrator_catalog_changed_outside_exact_reviewed_bootstrap_delta");
  }
}

export async function assertAceSchemaOwner(pool: Queryable): Promise<void> {
  const result = await pool.query("select pg_get_userbyid(nspowner) owner from pg_namespace where nspname='ace_hunter'");
  if (result.rows.length !== 1 || result.rows[0]?.owner !== "ace_hunter_owner") throw new Error("invalid_ace_schema_owner");
}

export async function recordAdminCatalog(pool: Queryable, file: string): Promise<string> {
  const catalog = await captureAdminCatalog(pool);
  await writeFile(file, JSON.stringify(canonicalizeCatalog(catalog)), { flag: "wx", mode: 0o600 });
  return fingerprint(catalog);
}

function fingerprint(catalog: Catalog): string {
  return createHash("sha256").update(JSON.stringify(canonicalizeCatalog(catalog))).digest("hex");
}

async function main(): Promise<void> {
  const [operation, file] = process.argv.slice(2);
  if (!file || (operation !== "record" && operation !== "verify")) throw new Error("usage: record|verify <fingerprint-file>");
  const pool = new Pool({
    connectionString: loadAdminConfig(process.env).adminDatabaseUrl,
    connectionTimeoutMillis: 15_000,
    query_timeout: 120_000,
    statement_timeout: 120_000,
  });
  try {
    const current = await captureAdminCatalog(pool);
    if (operation === "record") await writeFile(file, JSON.stringify(canonicalizeCatalog(current)), { flag: "wx", mode: 0o600 });
    else {
      const before = JSON.parse(await readFile(file, "utf8")) as Catalog;
      assertCatalogEqualExceptAceRoles(before, current);
      await assertAceSchemaOwner(pool);
    }
    process.stdout.write(`${fingerprint(current)}\n`);
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
