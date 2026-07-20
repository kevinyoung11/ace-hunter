# Ace Hunter Vercel Ops 与 X Worker 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 恢复并加固 X 采集链路，交付受 Vercel 保护的 Ops 控制台，使管理员能维护 Job、Worker 和系统健康状态，且现有 JobRunner 仍是唯一执行事实源。

**Architecture:** 先把一次性 0001 初始化迁移升级成版本化迁移；之后添加 PostgreSQL 控制面表、最小权限角色和原子命令领取函数。Mac X Worker 主动从数据库领取本机命令并复用现有 JobDispatcher；Vercel 只展示、配置、创建命令和分发 GitHub Workflow，不运行长任务或保存 X 会话。

**Tech Stack:** Node.js 22, TypeScript, PostgreSQL/Supabase, pg, Zod, Vitest, Next.js 16, React 19, GitHub Actions, macOS LaunchAgent, Vercel Deployment Protection.

---

## 总体边界与质量门禁

- 所有生产行为严格 TDD：失败测试 → 确认 RED → 最小实现 → 确认 GREEN。
- 单元测试不读取生产凭据；数据库集成测试只使用 ACE_TEST_* 专用库。
- 不修改已发布 0001；所有 schema 变更追加新迁移并记录 checksum。
- Ops 不允许任意 SQL、Shell、凭据查看/编辑、Mac 入站控制或终止正在运行的任务。
- 旧 GitHub cron 和旧 X wrapper 在新 Tick/Worker 真实对账完成前保留回退，切换过程不得重复执行。
- 每个任务完成后：实现者自测 → 规格审查 → 代码质量审查；发现问题必须修复并复审。

### Task 1: 建立 Node 22 与版本化迁移基础

**Files:**
- Create: src/db/migration-manifest.ts
- Create: src/db/migrations/0002_vercel_ops_control_plane.sql
- Modify: src/db/migrate.ts
- Modify: src/db/schema-manifest.ts
- Modify: tests/integration/db/migrations.test.ts
- Modify: tests/helpers/test-database.ts
- Modify: package.json

- [ ] **Step 1: 写失败的升级迁移测试**

在空库执行 migrate，断言 migration history 为 0001、0002；第二次执行不新增记录；历史 checksum 被修改时拒绝：

~~~
expect(await appliedMigrationIds(pool)).toEqual([
  "0001_ace_hunter_initial",
  "0002_vercel_ops_control_plane",
]);
await migrate(pool, config);
expect(await appliedMigrationIds(pool)).toHaveLength(2);
~~~

- [ ] **Step 2: 运行并确认 RED**

~~~
NODE_PATH="$(scripts/resolve-node22.sh)" npm run test:run -- tests/integration/db/migrations.test.ts
~~~

预期：不存在 migration history/0002，而不是连接生产库。

- [ ] **Step 3: 最小实现**

创建 schema_migrations(id primary key, checksum, applied_at)。manifest 严格排序：

~~~
export const migrations = [
  { id: "0001_ace_hunter_initial", file: "0001_ace_hunter_initial.sql" },
  { id: "0002_vercel_ops_control_plane", file: "0002_vercel_ops_control_plane.sql" },
] as const;
~~~

已部署的完整旧 catalog 先安全登记已知 0001 checksum，再只运行 0002；空库按顺序运行两条。保留受限管理员路径。schema-manifest 将原业务表验证与控制面表验证分开。

- [ ] **Step 4: 确认 GREEN**

~~~
NODE_PATH="$(scripts/resolve-node22.sh)" npm run test:run -- tests/integration/db/migrations.test.ts tests/unit/db/test-database.test.ts tests/unit/scripts/supabase-safety-check.test.ts
~~~

- [ ] **Step 5: 提交**

~~~
git add src/db/migrate.ts src/db/migration-manifest.ts src/db/schema-manifest.ts src/db/migrations/0002_vercel_ops_control_plane.sql tests/integration/db/migrations.test.ts tests/helpers/test-database.ts package.json
git commit -m "feat: support versioned database migrations"
~~~

### Task 2: 验证并恢复固定运行时凭据，发布不再 bootstrap

**Files:**
- Create: scripts/verify-runtime-credential.ts
- Modify: scripts/prepare-live-env.ts
- Modify: scripts/run-post-merge-release.sh
- Modify: scripts/release-transaction.mjs
- Modify: tests/unit/scripts/prepare-live-env.test.ts
- Modify: tests/unit/scripts/release-transaction.test.ts
- Modify: tests/unit/operations/deploy-main.test.ts

- [ ] **Step 1: 写失败测试**

模拟格式正确却认证失败的 runtime DSN，断言 release 返回稳定错误且不覆盖文件：

~~~
await expect(prepareLiveEnv({ mode: "release", credentialStore, connect }))
  .rejects.toThrow("runtime_credential_auth_failed");
expect(await readFile(runtimeEnv, "utf8")).toBe(beforeRuntimeEnv);
~~~

另断言 store 不存在时发布始终传 --mode release，并报 fixed_credentials_required，绝不转 bootstrap。

- [ ] **Step 2: 确认 RED**

~~~
NODE_PATH="$(scripts/resolve-node22.sh)" npm run test:run -- tests/unit/scripts/prepare-live-env.test.ts tests/unit/scripts/release-transaction.test.ts tests/unit/operations/deploy-main.test.ts
~~~

- [ ] **Step 3: 最小实现**

verify-runtime-credential 通过 runtime role 执行 select 1 和受控事务读写，只输出错误码。release 必须验证已有 Runtime/Migration DSN，失败不得写 runtime.env。

增加明确 recover 模式：进程锁 → admin 设置候选密码 → 验证候选 DSN → 0600 临时文件原子替换 credential store/runtime.env。候选失败且数据库状态已改变时返回 database_credential_recovery_required，保留旧文件，不伪称可回滚数据库密码。run-post-merge-release 永远 release；release transaction 显式记录 externalDatabaseCredentialMutation，出现外部变化时要求人工恢复。

- [ ] **Step 4: 确认 GREEN 并提交**

~~~
NODE_PATH="$(scripts/resolve-node22.sh)" npm run test:run -- tests/unit/scripts/prepare-live-env.test.ts tests/unit/scripts/release-transaction.test.ts tests/unit/operations/deploy-main.test.ts
git add scripts/verify-runtime-credential.ts scripts/prepare-live-env.ts scripts/run-post-merge-release.sh scripts/release-transaction.mjs tests/unit/scripts/prepare-live-env.test.ts tests/unit/scripts/release-transaction.test.ts tests/unit/operations/deploy-main.test.ts
git commit -m "fix: verify fixed runtime credentials before release"
~~~

### Task 3: X 运行时门禁和默认阻断发布验收

**Files:**
- Modify: scripts/run-scheduled-x.sh
- Modify: ops/launchd/install.sh
- Modify: scripts/continue-post-merge-release.sh
- Modify: scripts/post-merge-acceptance.ts
- Modify: tests/unit/operations/launchd-wrapper.test.ts
- Modify: tests/unit/scripts/post-merge-acceptance.test.ts

- [ ] **Step 1: 写失败测试**

当 runtime verifier 退出 1 时，wrapper 不可调用任何 X job：

~~~
expect(executed).not.toContain("collect_x_posts");
expect(executed).not.toContain("analyze_x_posts");
expect(executed).not.toContain("collect_x_comments");
~~~

另断言发布缺少三条可归因 X job_runs 默认失败；只有精确 --allow-x-unavailable 可降级且记录 x_unavailable_allowed。

- [ ] **Step 2: RED → Step 3: 最小实现**

在 Twitter preflight 后调用编译后的 credential verifier。install 在替换 Agent 前运行同一门禁。continue-post-merge-release 默认等待同一 scheduler run 的 collect/analyze/comments 终态 success 或 partial，失败触发事务回滚。

- [ ] **Step 4: GREEN 与提交**

~~~
NODE_PATH="$(scripts/resolve-node22.sh)" npm run test:run -- tests/unit/operations/launchd-wrapper.test.ts tests/unit/scripts/post-merge-acceptance.test.ts
git add scripts/run-scheduled-x.sh ops/launchd/install.sh scripts/continue-post-merge-release.sh scripts/post-merge-acceptance.ts tests/unit/operations/launchd-wrapper.test.ts tests/unit/scripts/post-merge-acceptance.test.ts
git commit -m "fix: gate X scheduling on verified runtime health"
~~~

### Task 4: 控制面 schema、角色和原子领取函数

**Files:**
- Modify: src/db/migrations/0002_vercel_ops_control_plane.sql
- Create: ops/03_bootstrap_ops_roles.sql
- Modify: ops/01_bootstrap_roles.sql
- Modify: ops/02_activate_runtime_role.sql
- Modify: src/db/schema-manifest.ts
- Create: tests/integration/ops/control-plane-schema.test.ts
- Create: tests/integration/ops/permissions.test.ts
- Modify: tests/helpers/bootstrap-test-db.sql

- [ ] **Step 1: 写失败集成测试**

覆盖状态、唯一时间片、角色越权与并发领取：

~~~
await expect(insertDuplicateScheduledCommand(pool, "collect_x_posts", at))
  .rejects.toMatchObject({ code: "23505" });
await expect(queryAs(macWorkerPool, "select * from ace_hunter.job_definitions"))
  .rejects.toMatchObject({ code: "42501" });
expect((await Promise.all([claim("mac-a"), claim("mac-b")])).filter(Boolean)).toHaveLength(1);
~~~

- [ ] **Step 2: 确认 RED**

~~~
NODE_PATH="$(scripts/resolve-node22.sh)" npm run test:run -- tests/integration/ops/control-plane-schema.test.ts tests/integration/ops/permissions.test.ts
~~~

- [ ] **Step 3: 最小实现**

创建：
- job_definitions：九个预注册 Job、executor、enabled、UTC cron、timeout、默认参数、workflow。
- job_commands：queued/claimed/running/succeeded/partial/failed/cancelled、lease、job_run_id、idempotency、scheduled_for。
- worker_heartbeats：worker/capability/状态/当前命令/最后心跳。
- ops_audit_log：动作、actor、request/deployment id、脱敏 before/after。

创建 partial unique(job_name, scheduled_for) where scheduled_for is not null，领取索引。创建 SECURITY DEFINER、固定 search_path 的 claim_local_command、start_command、bind_command_run、complete_command、requeue_expired_unstarted_command、cancel_queued_command、heartbeat_worker。创建 ace_hunter_ops_server、ace_hunter_github_runtime、ace_hunter_mac_worker；只授予必要函数和数据访问，禁止 DDL/角色管理。

- [ ] **Step 4: GREEN 与提交**

~~~
NODE_PATH="$(scripts/resolve-node22.sh)" npm run test:run -- tests/integration/db/migrations.test.ts tests/integration/ops/control-plane-schema.test.ts tests/integration/ops/permissions.test.ts
git add src/db/migrations/0002_vercel_ops_control_plane.sql ops/01_bootstrap_roles.sql ops/02_activate_runtime_role.sql ops/03_bootstrap_ops_roles.sql src/db/schema-manifest.ts tests/helpers/bootstrap-test-db.sql tests/integration/ops
git commit -m "feat: add least-privilege job control plane"
~~~

### Task 5: 统一 Job Catalog、命令状态机和 Store

**Files:**
- Create: src/ops/job-catalog.ts
- Create: src/ops/job-command.ts
- Create: src/db/stores/job-definition-store.ts
- Create: src/db/stores/job-command-store.ts
- Create: src/db/stores/worker-heartbeat-store.ts
- Create: src/db/stores/ops-audit-store.ts
- Modify: src/cli/commands/jobs.ts
- Modify: src/cli/job-dispatcher.ts
- Create: tests/unit/ops/job-catalog.test.ts
- Create: tests/unit/ops/job-command.test.ts
- Create: tests/integration/ops/command-claim.test.ts

- [ ] **Step 1: RED tests**

~~~
expect(parseJobParameters("collect_github_trending", { period: "daily" })).toEqual({ period: "daily" });
expect(() => parseJobParameters("collect_x_posts", { shell: "x" })).toThrow("invalid_parameters");
expect(() => transitionCommand("running", "cancelled")).toThrow("invalid_command_transition");
~~~

覆盖 duplicate click、partial、lease 超时、已有 job_run 不重跑。

- [ ] **Step 2: 最小实现与 GREEN**

catalog 是唯一 Job 名/显示名/executor/workflow/Zod 参数定义；三条 X Job 只能 local。Store 只调用 Task 4 SQL 函数，TypeScript 不复制 SQL transition：

~~~
create(input): Promise<JobCommand>
claimLocal(workerId, leaseSeconds): Promise<JobCommand | null>
start(id, workerId): Promise<void>
bindRun(id, workerId, runId): Promise<void>
complete(input): Promise<void>
cancelQueued(id, actor): Promise<JobCommand>
~~~

CLI 与 dispatcher 复用 catalog，保持当前 attribution。

~~~
NODE_PATH="$(scripts/resolve-node22.sh)" npm run test:run -- tests/unit/ops/job-catalog.test.ts tests/unit/ops/job-command.test.ts tests/integration/ops/command-claim.test.ts tests/integration/cli/job-dispatcher.test.ts
~~~

- [ ] **Step 3: 提交**

~~~
git add src/ops src/db/stores src/cli/commands/jobs.ts src/cli/job-dispatcher.ts tests/unit/ops tests/integration/ops/command-claim.test.ts
git commit -m "feat: add validated job command service"
~~~

### Task 6: Mac X Worker、命令关联和 CLI

**Files:**
- Create: src/worker/mac-x-worker.ts
- Create: src/cli/commands/worker.ts
- Modify: src/cli/index.ts
- Modify: src/cli/runtime-dependencies.ts
- Modify: src/config/schema.ts
- Modify: src/jobs/job-runner.ts
- Create: tests/unit/worker/mac-x-worker.test.ts
- Create: tests/integration/worker/mac-x-worker.test.ts
- Modify: tests/unit/cli/index.test.ts
- Modify: tests/integration/cli/runtime-dependencies.test.ts

- [ ] **Step 1: RED tests**

~~~
const result = await worker.runOnce();
expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
  name: "collect_x_posts",
  parameters: expect.objectContaining({ command_id: command.id }),
}));
expect(await commands.read(command.id)).toMatchObject({
  status: "succeeded", jobRunId: expect.any(String),
});
~~~

覆盖非 X command、未知 capability、handler throw、partial、lease、已绑定 run、重复 runOnce。

- [ ] **Step 2: 最小实现**

runOnce 固定流程：heartbeat → claim → start → dispatcher → bind job_run_id → complete。只允许三条 X Job；command_id 进入 JobInput parameters，因此 JobRunner canonical idempotency 保证同一命令只产生一个实际 run。

新增：
~~~
ace-hunter worker x --once --worker-id <stable-id>
ace-hunter worker x --poll-seconds 30 --worker-id <stable-id>
~~~

轮询范围 5–300 秒。使用 ACE_HUNTER_MAC_WORKER_DATABASE_URL；idle heartbeat 不加载 GitHub/model，实际命令执行时才加载 X/analyzer。

- [ ] **Step 3: GREEN 与提交**

~~~
NODE_PATH="$(scripts/resolve-node22.sh)" npm run test:run -- tests/unit/worker/mac-x-worker.test.ts tests/integration/worker/mac-x-worker.test.ts tests/unit/cli/index.test.ts tests/integration/cli/runtime-dependencies.test.ts tests/integration/jobs/job-runner.test.ts
git add src/worker src/cli/commands/worker.ts src/cli/index.ts src/cli/runtime-dependencies.ts src/config/schema.ts src/jobs/job-runner.ts tests/unit/worker tests/integration/worker tests/unit/cli/index.test.ts tests/integration/cli/runtime-dependencies.test.ts
git commit -m "feat: add local X command worker"
~~~

### Task 7: 安全迁移 LaunchAgent 到短周期 Worker

**Files:**
- Create: scripts/run-x-worker.sh
- Modify: scripts/run-scheduled-x.sh
- Modify: ops/launchd/com.kevinyoung.ace-hunter.collect-x.plist
- Modify: ops/launchd/install.sh
- Modify: tests/unit/operations/launchd-wrapper.test.ts
- Modify: tests/unit/scripts/activate-launch-agent.test.ts

- [ ] **Step 1: RED tests**

断言 StartInterval=30、保持 owner-only env/绝对路径/锁/trap、空队列退出 0：

~~~
expect(plist).toContain("<key>StartInterval</key><integer>30</integer>");
expect(executed).toContain("worker x --once");
expect(executed).not.toContain("job collect_x_posts");
~~~

- [ ] **Step 2: 最小实现与 GREEN**

run-x-worker.sh 复用现有安全文件验证、代理白名单、锁和 signal cleanup，最后运行 worker x --once。run-scheduled-x.sh 只在 ACE_HUNTER_X_SCHEDULER_MODE=legacy 时跑旧三段管道，默认调用新 wrapper。plist 使用 30 秒 StartInterval；install 写稳定 Worker ID 和 DSN 文件路径，不写秘密到 plist。

~~~
NODE_PATH="$(scripts/resolve-node22.sh)" npm run test:run -- tests/unit/operations/launchd-wrapper.test.ts tests/unit/scripts/activate-launch-agent.test.ts tests/unit/scripts/release-transaction.test.ts
~~~

- [ ] **Step 3: 提交**

~~~
git add scripts/run-x-worker.sh scripts/run-scheduled-x.sh ops/launchd/com.kevinyoung.ace-hunter.collect-x.plist ops/launchd/install.sh tests/unit/operations/launchd-wrapper.test.ts tests/unit/scripts/activate-launch-agent.test.ts
git commit -m "feat: schedule X jobs through local worker"
~~~

### Task 8: GitHub executor 与固定 Tick 调度

**Files:**
- Create: src/ops/scheduler-tick.ts
- Create: src/worker/github-command.ts
- Modify: src/ops/job-catalog.ts
- Create: .github/workflows/ops-dispatch.yml
- Modify: .github/workflows/discover.yml
- Modify: .github/workflows/trending.yml
- Modify: .github/workflows/refresh-metrics.yml
- Modify: .github/workflows/daily-report.yml
- Modify: .github/workflows/retention.yml
- Modify: .github/workflows/evaluate-success.yml
- Create: tests/unit/ops/scheduler-tick.test.ts
- Create: tests/integration/ops/scheduling.test.ts
- Create: tests/unit/worker/github-command.test.ts

- [ ] **Step 1: RED tests**

~~~
await tick({ now, mode: "observe" });
expect(await commands.list()).toHaveLength(0);
await tick({ now, mode: "active" });
await tick({ now, mode: "active" });
expect(await commands.forSchedule("refresh_repo_metrics", slot)).toHaveLength(1);
~~~

并断言 github worker 拒绝 local command，workflow dispatch input 只能接受 UUID command_id。

- [ ] **Step 2: 最小实现**

Tick 使用数据库 now()、catalog 和 job_definitions.schedule。observe 只审计对账，active 用唯一时间片创建 command。ops-dispatch.yml 接受 command_id，领取 github command、运行 catalog job、绑定和同步终态。旧 cron 继续存在；只有连续七天 observe 对账无漏跑/重复，才在独立人工批准变更中删除。

- [ ] **Step 3: GREEN 与提交**

~~~
NODE_PATH="$(scripts/resolve-node22.sh)" npm run test:run -- tests/unit/ops/scheduler-tick.test.ts tests/integration/ops/scheduling.test.ts tests/unit/worker/github-command.test.ts tests/unit/operations/schedules.test.ts
git add src/ops/scheduler-tick.ts src/worker/github-command.ts src/ops/job-catalog.ts .github/workflows tests/unit/ops/scheduler-tick.test.ts tests/integration/ops/scheduling.test.ts tests/unit/worker/github-command.test.ts
git commit -m "feat: dispatch scheduled jobs through control plane"
~~~

### Task 9: 选择性引入私有 Ops Web 基础

**Files:**
- Modify: package.json, package-lock.json, tsconfig.json, eslint.config.js, .gitignore
- Create: next-env.d.ts, vercel.json, app/layout.tsx, app/globals.css, app/ops/layout.tsx
- Create: tests/integration/web/ops-shell.test.tsx

- [ ] **Step 1: RED tests**

~~~
expect(await renderRoute("/ops")).toContain("Ace Hunter Ops");
expect(await routeExists("/console")).toBe(false);
expect(await routeExists("/api/monitors")).toBe(false);
~~~

- [ ] **Step 2: 最小实现**

从 feature/ace-hunter-vercel-web-console 只选择性移植 Next/React、Testing Library、根 layout、全局样式和 build 配置。新增 dev:web/build:web/test:web。严禁迁入 login/auth、Supabase browser/server 客户端、旧 console/analyze/monitors 页面及 API；Ops 只位于 /ops/**。

- [ ] **Step 3: GREEN 与提交**

~~~
NODE_PATH="$(scripts/resolve-node22.sh)" npm run test:web -- tests/integration/web/ops-shell.test.tsx
NODE_PATH="$(scripts/resolve-node22.sh)" npm run build:web
git add package.json package-lock.json tsconfig.json eslint.config.js .gitignore next-env.d.ts vercel.json app tests/integration/web/ops-shell.test.tsx
git commit -m "feat: add private Ops web foundation"
~~~

### Task 10: Vercel Ops 服务层、受限 API 和审计

**Files:**
- Create: lib/ops/environment.ts, lib/ops/service.ts, lib/ops/http.ts
- Create: src/ops/health-service.ts, src/ops/audit-service.ts
- Create: app/api/ops/health/route.ts
- Create: app/api/ops/jobs/route.ts
- Create: app/api/ops/jobs/[name]/route.ts
- Create: app/api/ops/jobs/[name]/commands/route.ts
- Create: app/api/ops/commands/[id]/cancel/route.ts
- Create: app/api/ops/workers/route.ts
- Create: app/api/ops/sources/route.ts
- Create: app/api/ops/audit/route.ts
- Create: app/api/ops/tick/route.ts
- Create: tests/integration/web/ops-routes.test.ts

- [ ] **Step 1: RED tests**

~~~
const response = await post("/api/ops/jobs/collect_x_posts/commands", {
  action: "run", parameters: { shell: "x" },
});
expect(response.status).toBe(400);
expect(await response.json()).toEqual({ code: "invalid_parameters" });
expect(JSON.stringify(await getJson("/api/ops/health"))).not.toMatch(/postgres(?:ql)?:\/\//i);
~~~

覆盖错误 Origin 403、未知 Job 404、queued 可取消、running 拒绝取消、tick 缺 secret 401。

- [ ] **Step 2: 最小实现**

仅允许 ACE_HUNTER_OPS_DATABASE_URL、ACE_HUNTER_GITHUB_DISPATCH_TOKEN、ACE_HUNTER_GITHUB_OWNER、ACE_HUNTER_GITHUB_REPOSITORY、OPS_REQUEST_ORIGIN、OPS_TICK_SECRET。浏览器写请求要求同源 Origin、16KiB JSON 限制、no-store、request/deployment id、vercel-protected-admin 审计。

命令 API 用 catalog/store；github command 由服务端 workflow_dispatch。tick 只运行短调度。绝不读取 Runtime DSN、admin DSN、X 或模型密钥。

- [ ] **Step 3: GREEN 与提交**

~~~
NODE_PATH="$(scripts/resolve-node22.sh)" npm run test:web -- tests/integration/web/ops-routes.test.ts
NODE_PATH="$(scripts/resolve-node22.sh)" npm run test:run -- tests/unit/ops/job-catalog.test.ts tests/integration/ops/command-claim.test.ts
git add lib/ops src/ops/health-service.ts src/ops/audit-service.ts app/api/ops tests/integration/web/ops-routes.test.ts
git commit -m "feat: add protected Ops control APIs"
~~~

### Task 11: Ops 页面与固定安全操作

**Files:**
- Create: app/ops/page.tsx, app/ops/jobs/page.tsx, app/ops/jobs/[name]/page.tsx, app/ops/workers/page.tsx, app/ops/sources/page.tsx, app/ops/audit/page.tsx
- Create: components/ops/health-summary.tsx, job-table.tsx, job-detail.tsx, command-actions.tsx, worker-status.tsx, audit-table.tsx
- Create: tests/integration/web/ops-pages.test.tsx

- [ ] **Step 1: RED tests**

~~~
render(<JobTable jobs={[{ name: "collect_x_posts", status: "partial", enabled: true }]} />);
expect(screen.getByText("部分成功")).toBeVisible();
expect(screen.queryByText(/DSN|postgresql/i)).toBeNull();
~~~

覆盖 offline 显示“等待 Worker”，cancel 仅 queued，force run 有二次确认。

- [ ] **Step 2: 最小实现**

首页回答数据是否新鲜、哪个链路坏、能否安全重试。详情显示 run history、command 状态、白名单参数、失败摘要和父子 JobRun。只提供 Run、Retry、Pause、Enable、Cancel queued、Force run；时间同时显示 UTC/Asia-Shanghai，颜色独立区分 success/partial/failed/offline/stale。

- [ ] **Step 3: GREEN 与提交**

~~~
NODE_PATH="$(scripts/resolve-node22.sh)" npm run test:web -- tests/integration/web/ops-pages.test.tsx tests/integration/web/ops-routes.test.ts tests/integration/web/ops-shell.test.tsx
NODE_PATH="$(scripts/resolve-node22.sh)" npm run build:web
git add app/ops components/ops tests/integration/web/ops-pages.test.tsx
git commit -m "feat: add Vercel Ops dashboard"
~~~

### Task 12: 真实验收、Vercel 配置与运行手册

**Files:**
- Create: scripts/live-ops-smoke.ts
- Create: tests/contract/ops/live-ops-database.test.ts
- Modify: scripts/run-local-live-acceptance.sh, scripts/post-merge-acceptance.ts, .env.example, docs/operations/ace-hunter-runbook.md
- Create: docs/operations/vercel-ops.md

- [ ] **Step 1: RED dry-run test**

~~~
await expect(runLiveOpsSmoke({ env: {} })).rejects.toThrow("ops_live_configuration_required");
expect(redact(error.message)).not.toMatch(/postgres(?:ql)?:\/\//i);
~~~

覆盖缺 Ops DSN、Worker 离线、X command 长期 queued、三阶段未完成和 partial 语义。

- [ ] **Step 2: 最小实现**

live-ops-smoke 顺序验证：Ops role 健康读取 → 创建 local collect command → Mac 领取 → 绑定 JobRun → collect/analyze/comments → 业务表更新 → 审计；--dry-run 只检配置和权限。

Vercel runbook 固定要求：独立 ace-hunter-ops Project、Node 22、npm run build:web、Production/Preview Vercel Authentication、仅 Ops DSN/dispatch token。不得配置 runtime/admin/X/model 凭据；生产域不能保护时只用 protected deployment URL。记录 28P01 恢复所需 ALTER ROLE 权限、候选验证、原子切换及回滚边界。

- [ ] **Step 3: 自动化和真实验收**

~~~
NODE_PATH="$(scripts/resolve-node22.sh)" npm run test:run
NODE_PATH="$(scripts/resolve-node22.sh)" npm run lint
NODE_PATH="$(scripts/resolve-node22.sh)" npm run typecheck
NODE_PATH="$(scripts/resolve-node22.sh)" npm run build
NODE_PATH="$(scripts/resolve-node22.sh)" npm run build:web
NODE_PATH="$(scripts/resolve-node22.sh)" npm run skill:validate
git diff --check
~~~

获得有效 admin/runtime/ops DSN、X CLI 会话和 Vercel Project 后：

~~~
NODE_PATH="$(scripts/resolve-node22.sh)" node --import tsx scripts/prepare-live-env.ts --mode recover --source "$ACE_RECOVERY_SOURCE_ENV" --credential-store "$ACE_RUNTIME_CREDENTIAL_STORE"
NODE_PATH="$(scripts/resolve-node22.sh)" npm run smoke:x
NODE_PATH="$(scripts/resolve-node22.sh)" node --import tsx scripts/live-ops-smoke.ts
~~~

- [ ] **Step 4: 提交**

~~~
git add scripts/live-ops-smoke.ts tests/contract/ops/live-ops-database.test.ts scripts/run-local-live-acceptance.sh scripts/post-merge-acceptance.ts docs/operations/vercel-ops.md docs/operations/ace-hunter-runbook.md .env.example
git commit -m "docs: add Ops deployment and live acceptance"
~~~

### Task 13: 全量复核、PR、CI、合并与主线验收

**Files:** 仅修复前序任务验证或审查发现的问题；禁止无关重构。

- [ ] **Step 1: 逐项规格符合性审查**

逐项确认：版本化迁移、凭据门禁、X 阻断、权限、命令租约、Mac Worker、GitHub Tick、私有 API/UI、Vercel 保护、真实验收和回滚都有对应代码与测试。任何缺口先新增 RED 测试再修复。

- [ ] **Step 2: 全量质量门禁**

~~~
NODE_PATH="$(scripts/resolve-node22.sh)" npm run test:run
NODE_PATH="$(scripts/resolve-node22.sh)" npm run lint
NODE_PATH="$(scripts/resolve-node22.sh)" npm run typecheck
NODE_PATH="$(scripts/resolve-node22.sh)" npm run build
NODE_PATH="$(scripts/resolve-node22.sh)" npm run build:web
NODE_PATH="$(scripts/resolve-node22.sh)" npm run skill:validate
git diff --check
git status --short --branch
~~~

- [ ] **Step 3: 推送、PR 与合并**

~~~
git fetch origin
git merge origin/main
git push -u origin feature/vercel-ops-x-worker
gh pr create --base main --head feature/vercel-ops-x-worker --title "feat: add Vercel Ops control plane and X worker"
gh pr checks --watch --interval 10
gh pr merge --squash --delete-branch
git fetch origin
git log -1 --oneline origin/main
~~~

只在 PR 目标 main、非 draft、无冲突、required checks 成功时 merge。合并后在 origin/main SHA 运行最小 release 验收和 live-ops-smoke --dry-run；随后报告 PR、merge SHA、真实验收证据和人工验收入口。

