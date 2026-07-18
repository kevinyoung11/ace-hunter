import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { migrate } from "../../../src/db/migrate.js";

const adminPool = new Pool({ connectionString: process.env.ACE_TEST_ADMIN_DATABASE_URL });
const migratorPool = new Pool({
  connectionString: process.env.ACE_TEST_MIGRATION_DATABASE_URL,
});
const runtimePool = new Pool({
  connectionString: process.env.ACE_TEST_RUNTIME_DATABASE_URL,
});

const migrationSql = readFileSync(
  "src/db/migrations/0001_ace_hunter_initial.sql",
  "utf8",
);
const migrationChecksum = createHash("sha256").update(migrationSql).digest("hex");
const expectedTables = [
  "analysis_outputs",
  "github_trending_snapshots",
  "job_runs",
  "product_repositories",
  "product_x_posts",
  "products",
  "repositories",
  "repository_snapshots",
  "user_product_monitors",
];

async function emptyOwnerSchema() {
  await adminPool.query(
    "drop schema if exists ace_hunter cascade; create schema ace_hunter authorization ace_hunter_owner",
  );
}

async function restoreValidSchema() {
  await emptyOwnerSchema();
  await migrate(migratorPool, { expectedChecksum: migrationChecksum });
}

async function tableNames() {
  const result = await adminPool.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema='ace_hunter' order by 1",
  );
  return result.rows.map((row) => row.table_name);
}

beforeAll(restoreValidSchema);

afterAll(async () => {
  await restoreValidSchema();
  expect(await tableNames()).toEqual(expectedTables);
  await Promise.all([adminPool.end(), migratorPool.end(), runtimePool.end()]);
});

describe("complete schema", () => {
  beforeEach(restoreValidSchema);

  it("creates exactly nine owner-managed business tables through distinct roles", async () => {
    expect(await tableNames()).toEqual(expectedTables);
    expect((await migratorPool.query("select current_user")).rows[0].current_user).toBe(
      "ace_hunter_migrator",
    );
    expect((await runtimePool.query("select current_user")).rows[0].current_user).toBe(
      "ace_hunter_runtime",
    );

    const rows = await adminPool.query(
      `select c.relname,pg_get_userbyid(c.relowner) owner,c.relrowsecurity,c.relforcerowsecurity,
              has_table_privilege('public',c.oid,'select') public_select,
              has_table_privilege('ace_hunter_runtime',c.oid,'select,insert,update,delete') runtime_crud
         from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='ace_hunter' and c.relkind='r' order by 1`,
    );
    expect(rows.rows).toHaveLength(9);
    expect(
      rows.rows.every(
        (row) =>
          row.owner === "ace_hunter_owner" &&
          row.relrowsecurity &&
          row.relforcerowsecurity &&
          !row.public_select &&
          row.runtime_crud,
      ),
    ).toBe(true);

    const roles = await adminPool.query(
      `select rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,
              rolreplication,rolbypassrls
         from pg_roles where rolname like 'ace_hunter_%' order by 1`,
    );
    expect(roles.rows).toEqual([
      {
        rolname: "ace_hunter_migrator",
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
      },
      {
        rolname: "ace_hunter_owner",
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
      },
      {
        rolname: "ace_hunter_runtime",
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
      },
    ]);
    expect(
      (
        await adminPool.query(
          `select pg_has_role('ace_hunter_migrator','ace_hunter_owner','member') allowed,
                  pg_has_role('ace_hunter_runtime','ace_hunter_owner','member') runtime_member`,
        )
      ).rows[0],
    ).toEqual({ allowed: true, runtime_member: false });
  });

  it("enforces one primary repository per product", async () => {
    await runtimePool.query(
      "insert into ace_hunter.products(id,name,status) values('00000000-0000-4000-8000-000000000001','p','active')",
    );
    for (const suffix of ["2", "3"]) {
      await runtimePool.query(
        `insert into ace_hunter.repositories
          (id,github_repo_id,owner_login,name,full_name,repo_url,default_branch,github_created_at,is_fork,is_archived,is_template,is_mirror,status)
         values($1,$2,'o',$3,$4,$5,'main',now(),false,false,false,false,'active')`,
        [
          `00000000-0000-4000-8000-00000000000${suffix}`,
          Number(suffix),
          `r${suffix}`,
          `o/r${suffix}`,
          `https://github.com/o/r${suffix}`,
        ],
      );
    }
    await runtimePool.query(
      `insert into ace_hunter.product_repositories(product_id,repository_id,role,is_primary,link_source)
       values('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','primary',true,'discovery')`,
    );
    await expect(
      runtimePool.query(
        `insert into ace_hunter.product_repositories(product_id,repository_id,role,is_primary,link_source)
         values('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','primary',true,'discovery')`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("installs named checks, delete actions, policies, and least privilege grants", async () => {
    const checks = await adminPool.query<{ conname: string }>(
      `select conname from pg_constraint c join pg_namespace n on n.oid=c.connamespace
        where n.nspname='ace_hunter' and c.contype='c' order by 1`,
    );
    expect(checks.rows.map((row) => row.conname)).toEqual(
      expect.arrayContaining([
        "analysis_outputs_confidence_check",
        "analysis_outputs_period_check",
        "analysis_outputs_status_check",
        "analysis_outputs_time_check",
        "analysis_outputs_trigger_check",
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
        "repositories_owner_type_check",
        "repositories_status_check",
        "repository_snapshots_counts_check",
        "trending_collection_status_check",
      ]),
    );

    const policies = await adminPool.query(
      `select tablename,roles,cmd from pg_policies
        where schemaname='ace_hunter' order by tablename`,
    );
    expect(policies.rows).toHaveLength(9);
    expect(
      policies.rows.every(
        (row) => row.roles.includes("ace_hunter_runtime") && row.cmd === "ALL",
      ),
    ).toBe(true);

    const auth = await adminPool.query(
      `select has_schema_privilege('ace_hunter_owner','auth','usage') owner_auth_usage,
              has_table_privilege('ace_hunter_owner','auth.users','select') owner_auth_select,
              has_column_privilege('ace_hunter_owner','auth.users','id','references') owner_auth_references`,
    );
    expect(auth.rows[0]).toEqual({
      owner_auth_usage: true,
      owner_auth_select: false,
      owner_auth_references: true,
    });
  });

  it("rejects invalid statuses, counts, scores, relationships, and time ordering", async () => {
    await expect(
      runtimePool.query("insert into ace_hunter.products(name,status) values('bad','unknown')"),
    ).rejects.toMatchObject({ code: "23514" });
    await runtimePool.query(
      "insert into ace_hunter.products(id,name,status) values('00000000-0000-4000-8000-000000000011','ok','active')",
    );
    await runtimePool.query(
      `insert into ace_hunter.repositories
        (id,github_repo_id,owner_login,name,full_name,repo_url,default_branch,github_created_at,is_fork,is_archived,is_template,is_mirror,status)
       values('00000000-0000-4000-8000-000000000012',12,'o','r','o/r','https://github.com/o/r','main',now(),false,false,false,false,'active')`,
    );
    await expect(
      runtimePool.query(
        `insert into ace_hunter.repository_snapshots(repository_id,captured_at,granularity,stars)
         values('00000000-0000-4000-8000-000000000012',now(),'daily',-1)`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      runtimePool.query(
        `insert into ace_hunter.product_repositories(product_id,repository_id,role,is_primary,confidence,link_source)
         values('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000012','secondary',true,1.1,'manual')`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      runtimePool.query(
        `insert into ace_hunter.analysis_outputs(output_type,period_start,period_end,data_cutoff_at,status,title,rendered_markdown,analysis_version,trigger_type,started_at)
         values('daily_report','2026-07-20','2026-07-19','2026-07-19','complete','x','x','v1','schedule',now())`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      runtimePool.query(
        `insert into ace_hunter.job_runs(job_name,trigger_type,scheduled_for,status,started_at,attempt,idempotency_key)
         values('x','schedule',now(),'running',now(),3,'bad-attempt')`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("destructive migration guards", () => {
  beforeEach(emptyOwnerSchema);

  it("rejects a residual schema before DDL", async () => {
    await adminPool.query("create table ace_hunter.products(id uuid primary key)");
    await expect(
      migrate(migratorPool, { expectedChecksum: migrationChecksum }),
    ).rejects.toThrow(/catalog preflight/);
    expect(await tableNames()).toEqual(["products"]);
  });

  it("rolls back every DDL statement when one statement fails", async () => {
    const faultySql =
      "begin; set local role ace_hunter_owner; create table ace_hunter.partial(id int); select missing_function(); commit;";
    const checksum = createHash("sha256").update(faultySql).digest("hex");
    await expect(
      migrate(migratorPool, { expectedChecksum: checksum, sqlOverride: faultySql }),
    ).rejects.toThrow(/missing_function/);
    expect(await tableNames()).toEqual([]);
  });

  it("rejects a wrong checksum before catalog or DDL changes", async () => {
    await expect(
      migrate(migratorPool, { expectedChecksum: "0".repeat(64) }),
    ).rejects.toThrow(/checksum mismatch/);
    expect(await tableNames()).toEqual([]);
  });

  it("rejects an altered foreign-key delete action", async () => {
    await migrate(migratorPool, { expectedChecksum: migrationChecksum });
    await adminPool.query(
      `alter table ace_hunter.product_repositories
         drop constraint product_repositories_product_id_fkey,
         add constraint product_repositories_product_id_fkey foreign key(product_id)
           references ace_hunter.products(id) on delete restrict`,
    );
    await expect(
      migrate(migratorPool, { expectedChecksum: migrationChecksum }),
    ).rejects.toThrow(/catalog preflight/);
  });
});
