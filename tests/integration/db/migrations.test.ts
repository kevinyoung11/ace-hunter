import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { migrate } from "../../../src/db/migrate.js";
import { assertCatalogIsAbsentOrComplete } from "../../../src/db/schema-manifest.js";
import {
  createVerifiedTestPools,
  parseTestDatabaseConfig,
} from "../../helpers/test-database.js";

const testDatabaseConfig = parseTestDatabaseConfig(process.env);
const execFileAsync = promisify(execFile);

let adminPool: Pool;
let migratorPool: Pool;
let runtimePool: Pool;

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

beforeAll(async () => {
  ({ adminPool, migratorPool, runtimePool } = await createVerifiedTestPools(
    {
      ACE_TEST_ADMIN_DATABASE_URL: testDatabaseConfig.adminDatabaseUrl,
      ACE_TEST_MIGRATION_DATABASE_URL: testDatabaseConfig.migrationDatabaseUrl,
      ACE_TEST_RUNTIME_DATABASE_URL: testDatabaseConfig.runtimeDatabaseUrl,
    },
  ));
  await restoreValidSchema();
});

afterAll(async () => {
  await restoreValidSchema();
  expect(await tableNames()).toEqual(expectedTables);
  const catalogClient = await migratorPool.connect();
  try {
    expect(await assertCatalogIsAbsentOrComplete(catalogClient)).toBe("complete");
  } finally {
    catalogClient.release();
  }
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

  it("bootstrap removes historical Ace and Ace-granted Public ACL outside its schema", async () => {
    await adminPool.query("drop schema if exists ace_hunter_test_history cascade");
    try {
      await adminPool.query(
        `create schema ace_hunter_test_history;
         create table ace_hunter_test_history.fixture(id integer);
         grant usage on schema ace_hunter_test_history
           to ace_hunter_owner with grant option;
         grant select on ace_hunter_test_history.fixture
           to ace_hunter_owner with grant option;
         grant update(id) on ace_hunter_test_history.fixture
           to ace_hunter_owner with grant option;
         grant create on schema ace_hunter_test_history to public;
         grant insert on ace_hunter_test_history.fixture to public;
         grant select(id) on ace_hunter_test_history.fixture to public;
         set role ace_hunter_owner;
         grant usage on schema ace_hunter_test_history to public;
         grant select on ace_hunter_test_history.fixture to public;
         grant update(id) on ace_hunter_test_history.fixture to public;
         reset role`,
      );
      await execFileAsync("psql", [
        testDatabaseConfig.adminDatabaseUrl,
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        "tests/helpers/bootstrap-test-db.sql",
      ]);
      await expect(
        migrate(migratorPool, { expectedChecksum: migrationChecksum }),
      ).resolves.toBeUndefined();
      const residual = await adminPool.query<{ count: number }>(
        `select (
           (select count(*) from pg_namespace namespace_object
              cross join lateral aclexplode(namespace_object.nspacl) acl
              left join pg_roles grantee on grantee.oid=acl.grantee
              left join pg_roles grantor on grantor.oid=acl.grantor
             where namespace_object.nspname='ace_hunter_test_history'
               and (grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%')) +
           (select count(*) from pg_class table_object
              join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
              cross join lateral aclexplode(table_object.relacl) acl
              left join pg_roles grantee on grantee.oid=acl.grantee
              left join pg_roles grantor on grantor.oid=acl.grantor
             where namespace_object.nspname='ace_hunter_test_history'
               and (grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%')) +
           (select count(*) from pg_attribute column_object
              join pg_class table_object on table_object.oid=column_object.attrelid
              join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
              cross join lateral aclexplode(column_object.attacl) acl
              left join pg_roles grantee on grantee.oid=acl.grantee
              left join pg_roles grantor on grantor.oid=acl.grantor
             where namespace_object.nspname='ace_hunter_test_history'
               and (grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%'))
         )::int count`,
      );
      expect(residual.rows[0]?.count).toBe(0);
      const unrelatedPublic = await adminPool.query<{ count: number }>(
        `select (
           (select count(*) from pg_namespace namespace_object
              cross join lateral aclexplode(namespace_object.nspacl) acl
              join pg_roles grantor on grantor.oid=acl.grantor
             where namespace_object.nspname='ace_hunter_test_history'
               and acl.grantee=0 and grantor.rolname=current_user
               and acl.privilege_type='CREATE') +
           (select count(*) from pg_class table_object
              join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
              cross join lateral aclexplode(table_object.relacl) acl
              join pg_roles grantor on grantor.oid=acl.grantor
             where namespace_object.nspname='ace_hunter_test_history'
               and acl.grantee=0 and grantor.rolname=current_user
               and acl.privilege_type='INSERT') +
           (select count(*) from pg_attribute column_object
              join pg_class table_object on table_object.oid=column_object.attrelid
              join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
              cross join lateral aclexplode(column_object.attacl) acl
              join pg_roles grantor on grantor.oid=acl.grantor
             where namespace_object.nspname='ace_hunter_test_history'
               and column_object.attname='id' and acl.grantee=0
               and grantor.rolname=current_user and acl.privilege_type='SELECT')
         )::int count`,
      );
      expect(unrelatedPublic.rows[0]?.count).toBe(3);
    } finally {
      await adminPool.query("drop schema if exists ace_hunter_test_history cascade");
    }
  });

  it("production bootstrap preserves an activated complete deployment", async () => {
    try {
      await execFileAsync("psql", [
        testDatabaseConfig.adminDatabaseUrl,
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        "ops/01_bootstrap_roles.sql",
      ]);

      const runtimeRole = await adminPool.query<{ rolcanlogin: boolean }>(
        "select rolcanlogin from pg_roles where rolname='ace_hunter_runtime'",
      );
      expect(runtimeRole.rows[0]?.rolcanlogin).toBe(true);
      await expect(
        migrate(migratorPool, { expectedChecksum: migrationChecksum }),
      ).resolves.toBeUndefined();
    } finally {
      await execFileAsync("psql", [
        testDatabaseConfig.adminDatabaseUrl,
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        "tests/helpers/bootstrap-test-db.sql",
      ]);
    }
  });

  it("rejects invalid statuses, counts, scores, relationships, and time ordering", async () => {
    const rejectCheck = async (sql: string, values: unknown[] = []) => {
      await expect(runtimePool.query(sql, values)).rejects.toMatchObject({ code: "23514" });
    };
    await runtimePool.query(
      "insert into ace_hunter.products(id,name,status) values('00000000-0000-4000-8000-000000000011','ok','active')",
    );
    await runtimePool.query(
      `insert into ace_hunter.repositories
        (id,github_repo_id,owner_login,name,full_name,repo_url,default_branch,github_created_at,is_fork,is_archived,is_template,is_mirror,status)
       values('00000000-0000-4000-8000-000000000012',12,'o','r','o/r','https://github.com/o/r','main',now(),false,false,false,false,'active')`,
    );
    await rejectCheck(
      "insert into ace_hunter.products(name,status) values('bad','unknown')",
    );
    await rejectCheck(
      "insert into ace_hunter.products(name,status,x_collection_status) values('bad','active','unknown')",
    );
    await rejectCheck(
      `insert into ace_hunter.repositories
        (github_repo_id,owner_login,name,full_name,repo_url,default_branch,
         github_created_at,is_fork,is_archived,is_template,is_mirror,status,owner_type)
       values(999,'o','r','o/r','https://github.com/o/r','main',now(),
         false,false,false,false,'active','Bot')`,
    );
    await rejectCheck(
      `insert into ace_hunter.repositories
        (github_repo_id,owner_login,name,full_name,repo_url,default_branch,
         github_created_at,is_fork,is_archived,is_template,is_mirror,status)
       values(999,'o','r','o/r','https://github.com/o/r','main',now(),
         false,false,false,false,'unknown')`,
    );

    const linkPrefix = `insert into ace_hunter.product_repositories
      (product_id,repository_id,role,is_primary,confidence,link_source) values
      ('00000000-0000-4000-8000-000000000011',
       '00000000-0000-4000-8000-000000000012'`;
    await rejectCheck(`${linkPrefix},'unknown',false,0.5,'manual')`);
    await rejectCheck(`${linkPrefix},'secondary',true,0.5,'manual')`);
    await rejectCheck(`${linkPrefix},'primary',true,1.1,'manual')`);

    await rejectCheck(
      `insert into ace_hunter.repository_snapshots(repository_id,captured_at,granularity,stars)
       values('00000000-0000-4000-8000-000000000012',now(),'unknown',1)`,
    );
    await rejectCheck(
      `insert into ace_hunter.repository_snapshots(repository_id,captured_at,granularity,stars)
       values('00000000-0000-4000-8000-000000000012',now(),'daily',-1)`,
    );
    for (const column of [
      "forks",
      "commits_30d",
      "pr_total",
      "pr_open",
      "pr_merged",
      "releases_count",
      "issues_total",
      "issues_open",
      "issues_closed",
    ]) {
      await rejectCheck(
        `insert into ace_hunter.repository_snapshots
          (repository_id,captured_at,granularity,stars,${column})
         values('00000000-0000-4000-8000-000000000012',now(),'daily',1,-1)`,
      );
    }

    const trendingPrefix = `insert into ace_hunter.github_trending_snapshots
      (repository_id,period,captured_at,rank,stars_in_period,source_url,collection_status)
      values('00000000-0000-4000-8000-000000000012'`;
    await rejectCheck(`${trendingPrefix},'unknown',now(),1,1,'https://x','success')`);
    await rejectCheck(`${trendingPrefix},'daily',now(),0,1,'https://x','success')`);
    await rejectCheck(`${trendingPrefix},'daily',now(),1,-1,'https://x','success')`);
    await rejectCheck(`${trendingPrefix},'daily',now(),1,1,'https://x','unknown')`);

    let xSequence = 0;
    const rejectX = async (overrides: Record<string, unknown>) => {
      xSequence += 1;
      const row: Record<string, unknown> = {
        product_id: "00000000-0000-4000-8000-000000000011",
        x_post_id: `invalid-${xSequence}`,
        post_type: "original",
        author_id: "a",
        author_username: "a",
        content: "x",
        post_url: "https://x.test/post",
        x_created_at: new Date("2026-07-19T00:00:00Z"),
        likes: 0,
        reposts: 0,
        quotes: 0,
        replies: 0,
        ...overrides,
      };
      const columns = Object.keys(row);
      await rejectCheck(
        `insert into ace_hunter.product_x_posts(${columns.join(",")})
         values(${columns.map((_, index) => `$${index + 1}`).join(",")})`,
        Object.values(row),
      );
    };
    await rejectX({ post_type: "unknown" });
    await rejectX({ sentiment: "unknown" });
    await rejectX({ stance: "unknown" });
    await rejectX({ relevance_score: -0.1 });
    await rejectX({ automation_probability: 1.1 });
    for (const column of ["likes", "reposts", "quotes", "replies", "bookmarks", "views"]) {
      await rejectX({ [column]: -1 });
    }
    await rejectX({ post_type: "comment", in_reply_to_post_id: null });

    const userId = "00000000-0000-4000-8000-000000000013";
    await adminPool.query("insert into auth.users(id) values($1) on conflict do nothing", [
      userId,
    ]);
    await rejectCheck(
      `insert into ace_hunter.user_product_monitors(user_id,product_id,status)
       values($1,'00000000-0000-4000-8000-000000000011','unknown')`,
      [userId],
    );

    let analysisSequence = 0;
    const rejectAnalysis = async (overrides: Record<string, unknown>) => {
      analysisSequence += 1;
      const row: Record<string, unknown> = {
        output_type: "daily_report",
        period_start: new Date("2026-07-18T00:00:00Z"),
        period_end: new Date("2026-07-19T00:00:00Z"),
        data_cutoff_at: new Date("2026-07-19T00:00:00Z"),
        status: "complete",
        title: `analysis-${analysisSequence}`,
        rendered_markdown: "x",
        analysis_version: "v1",
        trigger_type: "schedule",
        started_at: new Date("2026-07-18T00:00:00Z"),
        ...overrides,
      };
      const columns = Object.keys(row);
      await rejectCheck(
        `insert into ace_hunter.analysis_outputs(${columns.join(",")})
         values(${columns.map((_, index) => `$${index + 1}`).join(",")})`,
        Object.values(row),
      );
    };
    await rejectAnalysis({ output_type: "unknown" });
    await rejectAnalysis({ status: "unknown" });
    await rejectAnalysis({ trigger_type: "unknown" });
    await rejectAnalysis({ confidence: 1.1 });
    await rejectAnalysis({ period_end: new Date("2026-07-17T00:00:00Z") });
    await rejectAnalysis({ completed_at: new Date("2026-07-17T00:00:00Z") });

    let jobSequence = 0;
    const rejectJob = async (overrides: Record<string, unknown>) => {
      jobSequence += 1;
      const row: Record<string, unknown> = {
        job_name: "test",
        trigger_type: "schedule",
        scheduled_for: new Date("2026-07-19T00:00:00Z"),
        status: "running",
        started_at: new Date("2026-07-19T00:00:00Z"),
        idempotency_key: `invalid-job-${jobSequence}`,
        ...overrides,
      };
      const columns = Object.keys(row);
      await rejectCheck(
        `insert into ace_hunter.job_runs(${columns.join(",")})
         values(${columns.map((_, index) => `$${index + 1}`).join(",")})`,
        Object.values(row),
      );
    };
    await rejectJob({ trigger_type: "unknown" });
    await rejectJob({ status: "unknown" });
    await rejectJob({ attempt: 3 });
    for (const column of [
      "items_expected",
      "items_succeeded",
      "items_failed",
      "items_skipped",
    ]) {
      await rejectJob({ [column]: -1 });
    }
    await rejectJob({ completed_at: new Date("2026-07-18T00:00:00Z") });
  });
});

describe("destructive migration guards", () => {
  beforeEach(emptyOwnerSchema);
  afterEach(restoreValidSchema);

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

  it("rejects a successfully committed migration that does not match the manifest", async () => {
    const incompleteSql =
      "begin; set local role ace_hunter_owner; create table ace_hunter.partial(id int); commit;";
    const checksum = createHash("sha256").update(incompleteSql).digest("hex");
    await expect(
      migrate(migratorPool, { expectedChecksum: checksum, sqlOverride: incompleteSql }),
    ).rejects.toThrow(/catalog preflight/);
    expect(await tableNames()).toEqual(["partial"]);
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

  it("rejects an extra column and a changed default", async () => {
    await migrate(migratorPool, { expectedChecksum: migrationChecksum });
    await adminPool.query(
      "alter table ace_hunter.products add column unexpected text",
    );
    await expect(
      migrate(migratorPool, { expectedChecksum: migrationChecksum }),
    ).rejects.toThrow(/catalog preflight/);

    await adminPool.query("alter table ace_hunter.products drop column unexpected");
    await adminPool.query(
      "alter table ace_hunter.products alter column status set default 'active'",
    );
    await expect(
      migrate(migratorPool, { expectedChecksum: migrationChecksum }),
    ).rejects.toThrow(/catalog preflight/);
  });

  it("rejects a same-name index with a different definition", async () => {
    await migrate(migratorPool, { expectedChecksum: migrationChecksum });
    await adminPool.query(
      `drop index ace_hunter.analysis_outputs_product_unique;
       create unique index analysis_outputs_product_unique
         on ace_hunter.analysis_outputs(output_type,product_id,period_end,period_start)
         where output_type='product_analysis' and product_id is not null`,
    );
    await expect(
      migrate(migratorPool, { expectedChecksum: migrationChecksum }),
    ).rejects.toThrow(/catalog preflight/);
  });

  it("rejects a same-name check with a different expression", async () => {
    await migrate(migratorPool, { expectedChecksum: migrationChecksum });
    await adminPool.query(
      `alter table ace_hunter.products drop constraint products_status_check;
       alter table ace_hunter.products add constraint products_status_check
         check(status in ('active','inactive','paused'))`,
    );
    await expect(
      migrate(migratorPool, { expectedChecksum: migrationChecksum }),
    ).rejects.toThrow(/catalog preflight/);
  });

  it("rejects a same-name foreign key with different columns or target", async () => {
    await migrate(migratorPool, { expectedChecksum: migrationChecksum });
    await adminPool.query(
      `alter table ace_hunter.product_repositories
         drop constraint product_repositories_product_id_fkey,
         add constraint product_repositories_product_id_fkey foreign key(product_id)
           references auth.users(id) on delete cascade`,
    );
    await expect(
      migrate(migratorPool, { expectedChecksum: migrationChecksum }),
    ).rejects.toThrow(/catalog preflight/);
  });

  it("rejects a same-name policy with different expressions", async () => {
    await migrate(migratorPool, { expectedChecksum: migrationChecksum });
    await adminPool.query(
      `drop policy products_runtime on ace_hunter.products;
       create policy products_runtime on ace_hunter.products for all
         to ace_hunter_runtime using (false) with check (false)`,
    );
    await expect(
      migrate(migratorPool, { expectedChecksum: migrationChecksum }),
    ).rejects.toThrow(/catalog preflight/);
  });

  it("rejects any additional table privilege", async () => {
    await migrate(migratorPool, { expectedChecksum: migrationChecksum });
    await adminPool.query(
      "grant truncate on ace_hunter.products to ace_hunter_runtime",
    );
    await expect(
      migrate(migratorPool, { expectedChecksum: migrationChecksum }),
    ).rejects.toThrow(/catalog preflight/);
  });
});
