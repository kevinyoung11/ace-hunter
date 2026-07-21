# Vercel Ops 与 X Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 X runtime 数据库凭证并交付受 Vercel 保护的 Job Ops 控制面、PostgreSQL 命令队列和本机 X Worker，完成真实端到端验收后通过 PR 合并 main。

**Architecture:** 保留现有 JobRunner/job_runs、GitHub Actions 和 Mac 执行环境。Vercel 只处理短 API、配置和命令分发；GitHub executor 执行云端长 Job；Mac Worker 主动领取 local X 命令并顺序执行 collect → analyze → comments。旧 cron/LaunchAgent 在迁移验收完成前保留。

**Tech Stack:** Node 22, TypeScript, PostgreSQL/Supabase, Commander, Next.js 16, React 19, Vercel Deployment Protection, GitHub Actions, Vitest.

---

## 执行规则

所有行为采用 TDD：写一个最小失败测试 → 运行并确认失败原因 → 最小实现 → 局部/回归测试 → commit。每个任务由新的 implementer subagent 执行，再按“spec compliance review → code quality review”顺序审查；审查有问题必须修复并重审。只读调研和审查可并行，互相修改相同接口的实现不并行。

依赖顺序：

```text
1 基线
  → 2 X 凭证/发布门禁
  → 3 0002 控制面迁移/角色
  → 4 注册表/命令服务
  → 5 Mac Worker
  → 6 GitHub Executor/Tick
  → 7 Ops API
  → 8 Ops UI
  → 9 X/命令真实验收
  → 10 Vercel、PR、main 合并验收
```

## Task 1: Node 22 与专用测试库基线

**Files:** `scripts/resolve-node22.sh`, `tests/helpers/test-database.ts`, `vitest.config.ts`（仅在测试证明需要时修改）。

- [ ] 写测试：Node 选择必须落在 22；缺少 `ACE_TEST_ADMIN_DATABASE_URL` 必须显式失败且不得读取生产 DSN。
- [ ] 运行 `node --version && npm run test:run -- tests/unit/scripts/resolve-node22.test.ts`，记录当前 Node 26/测试 URL 缺失的真实失败。
- [ ] 用仓库脚本选择 Node 22；仅配置隔离的 `ACE_TEST_ADMIN_DATABASE_URL`、`ACE_TEST_MIGRATION_DATABASE_URL`、`ACE_TEST_RUNTIME_DATABASE_URL`，运行 `tests/helpers/bootstrap-test-db.sql`。
- [ ] 运行 `npm run test:run && npm run typecheck && npm run lint && npm run build`，全部非 live 套件通过后 commit：`test: establish Node 22 database baseline`。

## Task 2: X runtime 凭证恢复与发布一致性

**Files:** 新建 `scripts/verify-runtime-credential.ts`；修改 `scripts/prepare-live-env.ts`、`scripts/run-post-merge-release.sh`、`scripts/continue-post-merge-release.sh`、`scripts/release-transaction.mjs`、`scripts/run-scheduled-x.sh`、`ops/launchd/install.sh`；测试 `tests/unit/scripts/prepare-live-env.test.ts`、`tests/unit/scripts/release-transaction.test.ts`、`tests/unit/operations/launchd-wrapper.test.ts`、`tests/unit/operations/deploy-main.test.ts`、`tests/unit/scripts/post-merge-acceptance.test.ts`。

- [ ] RED：测试格式正确但密码失效的 DSN；当前 release 必须先失败，且输出不可含 DSN/password。
- [ ] GREEN：实现 `verifyRuntimeCredential(connectionString, {queryable, expectedRole})`，只返回稳定 code；release 固定使用 `--mode release`，缺 store 返回 `fixed_credentials_required`，不静默 bootstrap 或 `alter role`。
- [ ] RED/GREEN：恢复路径先用候选 DSN 做连接、最小读和受控写，成功后临时文件 + rename 原子替换 owner-only store/runtime；失败返回 `database_credential_recovery_required`，保留旧文件，不声称数据库密码已 rollback。
- [ ] RED/GREEN：release transaction 记录“外部 DB 未修改/已修改需人工恢复”；X preflight 在三个 Job 之前执行；默认 X 三阶段失败阻断安装和发布，只有显式 `--allow-x-unavailable` 才降级。
- [ ] 运行局部测试、typecheck、lint，提交 `fix: gate X scheduling on runtime credential health`。
- [ ] 真实前置：用有效管理 DSN 在生产窗口恢复 runtime role；随后按 collect_x_posts → analyze_x_posts → collect_x_comments 检查 job_runs、业务表、LaunchAgent 日志。失败时停在凭证恢复，不继续部署。

## Task 3: 0002 控制面迁移、角色和数据库函数

**Files:** 修改 `src/db/migration-manifest.ts`、`src/db/schema-manifest.ts`；新建 `src/db/migrations/0002_vercel_ops_control_plane.sql`、`ops/03_bootstrap_ops_roles.sql`、`ops/04_activate_ops_roles.sql`；更新 `tests/helpers/bootstrap-test-db.sql`；新建 `tests/integration/ops/permissions.test.ts`、`tests/integration/ops/command-claim.test.ts`。

- [ ] RED：migration history、表、约束、函数和 role matrix 测试先失败；确认 0001 checksum/fingerprint 不变。
- [ ] GREEN：让 migration loader 按文件名加载 0001/0002，单独记录 0002 checksum；新增 `job_definitions`、`job_commands`、`worker_heartbeats`、`ops_audit_log`，seed 九个预注册 Job；命令状态为 queued → claimed → running → succeeded|partial|failed，queued 可 cancelled；自动命令按 job+scheduled_for 唯一，命令按 idempotency_key 唯一。
- [ ] GREEN：创建 Ops、GitHub Runtime、Mac Worker 最小角色；用 SECURITY DEFINER + 固定 search_path 实现 claim/start/bind/complete/cancel/requeue/heartbeat，claim 使用 `FOR UPDATE SKIP LOCKED`。
- [ ] 运行 migration、并发 claim、跨 executor 越权、ACL/RLS 测试及 `npm run safety:schema && npm run safety:runtime`，提交 `feat: add job control plane schema`。

## Task 4: Job registry、命令状态机和审计

**Files:** 新建 `src/ops/job-catalog.ts`、`src/ops/job-command.ts`、`src/ops/command-service.ts`、`src/db/stores/job-definition-store.ts`、`src/db/stores/job-command-store.ts`、`src/db/stores/worker-heartbeat-store.ts`、`src/db/stores/ops-audit-store.ts`；修改 `src/cli/job-dispatcher.ts`、`src/cli/commands/jobs.ts`；测试 `tests/unit/ops/job-catalog.test.ts`、`tests/unit/ops/command-service.test.ts`。

- [ ] RED：未知 Job/字段、X 非 local、非法 period/batch、状态逆向转移、重复点击和 queued 以外 cancel 的测试先失败。
- [ ] GREEN：注册表成为唯一九 Job/参数/executor/workflow/capability 白名单；stores 只调用数据库函数；service 创建、pause、enable、run、retry、cancel queued 并写审计。
- [ ] GREEN：command_id UUID 进入 JobInput canonical parameters/idempotency；公开 CLI 保留原 attribution，不接受任意客户端 command 参数。
- [ ] 运行 ops、dispatcher、existing integration suites，提交 `feat: add validated job command service`。

## Task 5: Mac X Worker 和 LaunchAgent

**Files:** 新建 `src/worker/mac-x-worker.ts`、`src/cli/commands/worker.ts`、`scripts/run-local-worker.sh`；修改 `src/cli/index.ts`、`src/cli/runtime-dependencies.ts`、`ops/launchd/com.kevinyoung.ace-hunter.collect-x.plist`、`ops/launchd/install.sh`；测试 `tests/unit/worker/mac-x-worker.test.ts`、`tests/unit/operations/launchd-wrapper.test.ts`、`tests/integration/ops/command-claim.test.ts`。

- [ ] RED：fake store/dispatcher 测试 heartbeat → claim → start → dispatcher → bind run → terminal sync、lease、重复 command、非 local/X capability 拒绝。
- [ ] GREEN：Worker 只声明三个 X Job capability，复用 `createJobDispatcher`，每 tick 最多领取一项；X 命令必须满足 collect → analyze → comments lineage，不能让 downstream 先跑。
- [ ] RED/GREEN：`ace-hunter worker x --once|--poll-seconds N --worker-id ID` 参数、退避、脱敏错误、owner/mode/symlink/lock/signal cleanup。
- [ ] staging 安装新 wrapper，不替换旧 wrapper；写测试命令验证 heartbeat、领取、三个 X Job、job_runs、products/product_x_posts；提交 `feat: run X jobs through local worker`。

## Task 6: GitHub Executor 与动态 Tick

**Files:** 新建 `src/ops/scheduler-tick.ts`、`src/ops/github-dispatcher.ts`、`.github/workflows/ops-command.yml`、`.github/workflows/ops-tick.yml`；修改现有定时 workflows；测试 `tests/unit/ops/scheduler-tick.test.ts`、`tests/unit/ops/github-dispatcher.test.ts`、`tests/integration/ops/scheduling.test.ts`。

- [ ] RED：UTC 到期、paused、时间片唯一、观察模式、dispatch 失败和重复 command 测试先失败。
- [ ] GREEN：tick 只用数据库 now 创建 command 并 dispatch workflow，立即返回；workflow 只领取指定 command_id，使用 registry 验证，执行后绑定 job_run。保留旧 cron 作为 fallback。
- [ ] 运行 unit/integration/tick 测试、typecheck；在非生产仓库做 workflow dispatch dry run；提交 `feat: dispatch scheduled jobs through command queue`。

## Task 7: Vercel Ops server/API

**Files:** 从 `feature/ace-hunter-vercel-web-console` 选择性移植 Next build 基础；新建 `lib/ops/environment.ts`、`lib/ops/service.ts`、`lib/ops/http.ts`；新建 routes `app/api/ops/health`、`jobs`、`jobs/[name]`、`jobs/[name]/commands`、`commands/[id]/cancel`、`workers`、`sources`、`audit`、`tick`；测试 `tests/integration/web/ops-routes.test.ts`。

- [ ] RED：未保护/错误 Origin、未知 Job/参数、超大请求、敏感错误泄露、非 cron tick、读写隔离测试先失败。
- [ ] GREEN：只读 `ACE_HUNTER_OPS_DATABASE_URL`、GitHub dispatch 配置和 origin；不读 runtime/admin/migrator/X/DeepSeek secrets。API 使用 Node runtime、no-store、稳定错误码、correlation id、Origin/CSRF 校验。
- [ ] GREEN：GET 健康/Job/Worker/来源/审计；POST 只允许预注册 run/retry/pause/enable/force-run；cancel 只允许 queued；tick 只创建/分发 command，不执行 Job。
- [ ] 运行 `npm run test:run -- tests/integration/web/ops-routes.test.ts && npm run build:web && npm run lint`，提交 `feat: add protected Vercel ops API`。

## Task 8: Ops UI

**Files:** 新建 `app/ops/layout.tsx`、`app/ops/page.tsx`、`app/ops/jobs/page.tsx`、`app/ops/jobs/[name]/page.tsx`、`app/ops/workers/page.tsx`、`app/ops/sources/page.tsx`、`app/ops/audit/page.tsx` 及 `components/ops/*`；测试 `tests/integration/web/ops-pages.test.tsx`。

- [ ] RED：fixtures 覆盖 success/partial/failed/offline/stale、queued、lineage、二次确认、无 secret 渲染。
- [ ] GREEN：总览回答数据新鲜度/坏链路/安全重试；Job 详情显示参数/计数/失败项/父子运行/下一计划；Worker/来源/审计页显示心跳、版本、能力、脱敏健康和 `vercel-protected-admin`。
- [ ] 运行 Web integration、build:web、lint，提交 `feat: add Vercel ops dashboard`。

## Task 9: X 和命令队列真实验收

**前置：** Tasks 2–8 局部测试通过；需要有效管理 DSN、已认证 X CLI、Mac LaunchAgent 权限和生产窗口。

- [ ] 只记录 owner-only 文件存在性、权限、hash、release 指针，不输出内容。
- [ ] 执行候选 runtime credential recovery，验证真实连接/最小读/受控写后原子替换；失败则停止。
- [ ] 真实顺序运行 collect_x_posts → analyze_x_posts → collect_x_comments；核对 job_runs attribution、状态、计数、业务表和日志。
- [ ] 写一次 local command，确认 Mac heartbeat/claim/lease/run binding/终态；重复 command id 不重复 JobRun；Mac 离线显示 queued，恢复后继续。
- [ ] 在隔离库注入失效 DSN，确认发布/安装阻断、旧 Agent 不启动、日志无 secret。保存脱敏 command/job IDs 作为证据。

## Task 10: Vercel、PR、main 和最终验收

- [ ] 运行完整 `npm run test:run`、`npm run typecheck`、`npm run lint`、`npm run build`、`npm run build:web`、`npm run skill:validate`、`git diff --check`；失败必须修复。
- [ ] `git fetch origin main && git merge origin/main`，检查 diff，commit/push feature branch；不 reset/force-push/覆盖无关文件。
- [ ] 建立独立 Vercel Ops Project，Node 22、`npm run build:web`、最小 Ops DSN、GitHub dispatch 配置、origin/tick secret；启用 Vercel Authentication。禁止配置 runtime/admin/migrator/X/DeepSeek secrets。未认证浏览器必须被拦截，授权成员可访问。
- [ ] 用 `gh pr create --base main` 创建 PR；`gh pr checks --watch --interval 10` 等待所有 required checks。失败时新增回归测试并修复。
- [ ] 仅当 PR checks 全绿且可合并时 `gh pr merge --squash --delete-branch`；fetch 后确认 `origin/main` 包含最终 SHA。
- [ ] 从最终 main SHA 再跑 GitHub potential、Trending 日/周/月、受保护 Ops、Mac heartbeat、X 三阶段、凭证门禁和 release/current/wrapper/Skill/LaunchAgent 不可变 SHA 对齐验收。全部证据齐全后才通知人工验收。

## 总验收边界

**功能：** 失效 DSN 在 release/preflight 被拒；候选凭证验证后才切换；X 三阶段按顺序完成且可追踪；Ops 可查看、暂停、启用、触发、重试和取消 queued；GitHub 长任务不在 Vercel Function；Mac 离线命令保持等待并可恢复；重复 command 不重复 JobRun。

**安全：** Ops 受 Vercel Authentication/保护 Deployment；Vercel 仅 Ops 最小 DSN；executor/capability 隔离；API/log 不返回 secret；mutation 有审计和幂等键。

**可靠性：** SKIP LOCKED 单领取；lease 可恢复且已有 JobRun 不重跑；partial 独立展示；旧 cron/LaunchAgent 直到观察模式和真实对账完成才移除。

**工程：** 每个行为有 RED/GREEN 记录；全套 test/typecheck/lint/build/web build/skill validator 通过；PR required checks 全绿后 merge，合并后的 main 重新真实验收。

