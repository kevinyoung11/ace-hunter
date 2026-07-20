# Ace Hunter Vercel Ops 与 X Worker 设计

## 目标

把 Ace Hunter 的系统维护入口部署到 Vercel，同时保留现有 JobRunner、GitHub Actions 和本机 X 运行环境。管理员可以在受保护的 Vercel 后台查看系统健康度、维护 Job 配置、手动触发和重试任务；X 任务由 Mac Worker 领取后在本机执行。

本次交付包含两个有先后关系的子项目：

1. 恢复并加固 X 端到端链路，确保现有三个 X Job 能稳定写入数据库。
2. 建设 Vercel Ops 控制面和本机 Worker 命令通道，让后台可以维护系统功能。

不引入 Temporal、Inngest、Trigger.dev 等外部 Job 平台。现有 PostgreSQL JobRunner 继续作为执行事实源。

## 已确认的现状

- GitHub Actions 负责 GitHub 发现、Trending、指标刷新、日报、保留和成功评估等任务。
- macOS LaunchAgent 每六小时顺序执行 `collect_x_posts`、`analyze_x_posts` 和 `collect_x_comments`。
- `ace-hunter job <job-name>` 是统一执行入口。
- `job_runs` 已提供幂等键、运行锁、父子任务、重试次数、处理计数和 `success|partial|failed` 状态。
- 自动调度时间分散在 GitHub Workflow 和 LaunchAgent plist 中，数据库无法统一配置。
- X CLI 当前已登录，预检和真实搜索均可成功；端到端链路被 PostgreSQL `28P01` 运行时密码认证失败阻断。
- 当前发布事务能恢复本地凭证文件，却不能恢复已经修改的数据库角色密码，存在文件与数据库密码不一致的风险。
- Vercel Web Console 已在 `feature/ace-hunter-vercel-web-console` 分支实现基础页面与只读数据服务，但尚未进入当前 `main`，也没有 Job 运维控制面。

## 方案选择

采用“Vercel 控制面 + PostgreSQL 命令队列 + 多执行器”方案：

- Vercel 只处理短请求：展示状态、修改配置、写入命令、触发 GitHub Workflow。
- GitHub Actions 继续执行不依赖本机会话的长任务。
- Mac Worker 继续执行依赖本机 X 会话的任务。
- PostgreSQL 保存 Job 定义、命令、Worker 心跳、运行结果和审计记录。
- Vercel Function 不直接运行长 Job，也不持有 X Cookie 或本机执行能力。

不采用以下方案：

- **全部迁移到 Vercel Function：** X 会话不在 Vercel，现有长任务也可能超过 Function 时限。
- **接入外部 Job 平台：** 当前已有持久化执行层，接入后会产生两套状态、两套重试规则和额外本机 Worker 集成。
- **Vercel 直接调用 Mac 入站接口：** 需要暴露本机端口，增加公网入口、穿透和证书维护；本设计改为 Mac 主动领取命令。

## 系统边界

### 本次包含

- 独立的 Vercel Ops 部署与 Vercel Authentication 保护。
- Job 总览、详情、配置、手动触发、重试、暂停和启用。
- 数据源、数据库、调度器和 Worker 健康状态。
- X 三阶段链路的后台触发和进度展示。
- Job 定义、命令、Worker 心跳和管理员审计数据。
- 可配置调度的固定 Tick 机制。
- X 数据库凭证恢复和发布凭证一致性加固。

### 本次不包含

- 产品用户注册、登录、团队、租户和细粒度 RBAC。
- 在后台展示或编辑数据库密码、X Cookie、GitHub Token 和模型密钥。
- 任意 Shell、任意 SQL、文件浏览或远程桌面。
- 强制终止已经开始的本机进程；只允许取消尚未领取的命令。
- 通过后台部署代码、修改数据库 Schema 或回滚生产版本。
- 用新的 Job 平台替换现有 JobRunner。

## 部署与访问边界

Ops 使用独立 Vercel Project，不与未来的公开产品站共享保护边界。第一版复用现有 Web Console 的 Next.js 技术栈，但作为私有 Ops 应用部署；公开产品站以后使用另一个 Vercel Project。

Ops Project 必须启用 Vercel Authentication。浏览器管理 API 只接受经过部署保护的同源请求，服务端使用专用的最小权限数据库角色。浏览器端永远拿不到数据库 DSN 或高权限 Supabase Key。

V1 不实现应用内管理员身份，因此审计日志把操作者记录为 `vercel-protected-admin`，并附带请求 ID、部署 ID 和时间。该记录能证明操作来自受保护后台，但不承诺区分具体团队成员；以后引入应用身份时再增加个人标识。

如果当前 Vercel 套餐不能保护正式生产域名，Ops 只使用受保护的 Deployment/Preview URL，不绑定公开生产域名。

## 组件设计

### 1. Ops Web

在现有 Web Console 基础上新增 `/ops` 区域：

- `/ops`：系统总览和数据新鲜度。
- `/ops/jobs`：Job 列表、启用状态、调度、执行器、最近运行和下次运行。
- `/ops/jobs/[name]`：运行历史、参数、处理计数、失败项、父子运行和命令历史。
- `/ops/workers`：Mac Worker 在线状态、版本、能力、当前任务和最后心跳。
- `/ops/sources`：数据库、GitHub、Trending、X CLI 和模型分析健康状态。
- `/ops/audit`：配置修改、触发、重试、暂停和取消记录。

所有修改操作使用 `POST`，服务端验证 Job 名、动作和参数 Schema。读取接口只返回脱敏事实，不返回原始环境变量或完整底层异常。

### 2. Job Definition Service

`job_definitions` 是可维护配置的唯一事实源：

```text
job_name             text primary key
display_name         text not null
executor             github | local
enabled              boolean
schedule             UTC cron expression
timeout_seconds      positive integer
default_parameters   jsonb
workflow_file        nullable text
description          text
created_at            timestamptz
updated_at            timestamptz
```

只允许预注册 Job，不允许后台创建任意可执行命令。`default_parameters` 按每个 Job 的白名单 Schema 验证，例如 X batch size、Trending period 或刷新上限；未知字段被拒绝。

暂停 Job 会阻止新的自动命令和普通手动命令。管理员可以明确选择一次性 `force run`，该动作需要二次确认并写审计日志。

### 3. Job Command Service

`job_commands` 是控制面向执行器下发工作的持久化通道：

```text
id                    uuid primary key
job_name              references job_definitions
action                run | retry
target_executor       github | local
parameters            jsonb
status                queued | claimed | running | succeeded | partial | failed | cancelled
requested_by          text
requested_at          timestamptz
claimed_by            nullable text
claimed_at            nullable timestamptz
lease_expires_at      nullable timestamptz
job_run_id            nullable references job_runs
attempt               non-negative integer
idempotency_key       unique text
error_code            nullable text
error_summary         nullable text
completed_at          nullable timestamptz
```

命令状态只能按以下方向变化：

```text
queued -> claimed -> running -> succeeded | partial | failed
queued -> cancelled
claimed -> queued       仅租约超时且没有对应运行事实时
```

领取使用事务和 `FOR UPDATE SKIP LOCKED`，同时写入有限租约。Worker 崩溃后，过期命令可以重新排队；如果已经产生 `job_run_id`，则以 `job_runs` 为事实恢复状态，不能重复执行。

命令 ID 会进入 JobRunner 参数和幂等键。重复点击、网络重试和重复领取最多产生一次实际 Job Run。

### 4. Worker Registry

`worker_heartbeats` 保存执行器事实：

```text
worker_id             text primary key
worker_type           github | mac_x
version               text
capabilities          text[]
status                idle | busy | degraded
current_command_id    nullable uuid
last_seen_at           timestamptz
last_error_code       nullable text
```

超过两个心跳周期未更新即在 UI 标记离线。离线只影响命令等待状态，不把排队命令误判为失败。

### 5. Mac X Worker

现有 LaunchAgent 从“每六小时直接顺序跑三个 Job”演进为常驻或短周期 Worker：

1. 使用本机专用 Worker DSN 写入心跳。
2. 领取 `target_executor='local'` 且状态为 `queued` 的命令。
3. 通过现有 `createJobDispatcher` 执行白名单 Job，不拼接 Shell 字符串。
4. 把 `job_run_id` 绑定回命令，并同步最终状态。
5. 空闲时继续心跳；数据库暂时不可用时指数退避，不删除命令。

Worker 只声明三个 X 能力。即使数据库被写入其他 Job 名，它也必须拒绝执行。

### 6. GitHub Executor

现有 Workflow 继续承担云端长任务。Ops 手动触发时：

1. Vercel 写入 `target_executor='github'` 的命令。
2. 服务端使用只允许触发指定 Workflow 的 GitHub 凭据调用 `workflow_dispatch`，传递 `command_id`。
3. Workflow 领取指定命令并执行对应 Job。
4. `job_runs` 和 `job_commands` 同步最终状态。

自动调度迁移完成前，现有 Workflow cron 保留为回退路径。迁移后由单个固定 Tick 读取 `job_definitions`，为到期 Job 创建命令；Vercel 只做快速分发，长任务仍在 GitHub Actions 或 Mac 执行。

## 调度语义

- 所有 cron 使用 UTC，并在 UI 同时显示北京时间预览。
- Tick 使用数据库时间计算到期任务，避免 Vercel 与 Mac 时钟差异。
- 每个 Job 每个计划时间片只能存在一个自动命令，唯一键由 `job_name + scheduled_for` 生成。
- 修改 schedule 只影响保存后的下一个时间片，不补跑过去错过的全部周期。
- `enabled=false` 时 Tick 不创建新命令，已经运行的任务继续完成。
- 调度迁移必须采用双读对账：先让 Tick 以观察模式计算到期结果，再启用真实下发，最后移除旧 cron，避免重复或漏跑。

## X 链路恢复与加固

### 当前恢复

在建设后台前先恢复真实 X 链路：

1. 使用有效的管理凭据为运行角色设置新密码。
2. 在临时 owner-only 文件中生成候选 Runtime DSN。
3. 用候选 DSN 完成连接、最小读和受控写验证。
4. 验证成功后原子替换 `runtime-credentials.env` 和生成的 `runtime.env`。
5. 依次执行并验证 `collect_x_posts`、`analyze_x_posts`、`collect_x_comments`。
6. 同时核对 CLI 退出码、`job_runs`、业务表变化和 LaunchAgent 日志。

任何一步失败都不得输出密码，也不得删除最后一份可追溯凭证文件。

### 发布机制修复

发布流程把数据库密码修改视为不可通过文件复制自动回滚的外部状态：

- 发布前获取进程级互斥锁，禁止两个发布同时轮换角色密码。
- release 模式在复用凭证前必须进行真实数据库连接验证。
- bootstrap 模式先创建并验证候选凭证，再切换当前运行环境。
- 文件回滚不能宣称恢复了数据库密码；如果数据库角色已变化，回滚必须重新应用旧密码并验证，或者明确停止并报告需要人工恢复。
- 安装或启动 LaunchAgent 前必须通过运行角色读写检查和 X preflight。
- 发布验收把 X 失败恢复为阻断项；只有明确使用 `--allow-x-unavailable` 的非 X 发布才允许降级通过。

## 权限模型

至少保留三类数据库角色：

- **Ops Server：** 读取健康与运行事实，维护 Job 定义、命令和审计；不能执行迁移和修改角色。
- **GitHub Runtime：** 领取 GitHub 命令、写运行与业务事实；不能领取本机命令或修改 Job 定义。
- **Mac Worker：** 写自身心跳、领取本机命令、写 X 运行与业务事实；不能领取 GitHub 命令或修改 Job 定义。

所有权限通过数据库授权和带检查条件的函数/视图约束，不能只依赖 UI。Vercel 环境变量只保存 Ops Server 凭据；Mac Worker 凭据只保存在本机 owner-only 文件中。

## 错误处理与可观察性

- 后台 API 返回稳定错误码，例如 `job_disabled`、`worker_offline`、`invalid_parameters`、`command_conflict` 和 `source_unavailable`。
- 原始错误写入受限日志；UI 只显示脱敏摘要和关联 ID。
- `partial` 必须作为独立业务状态展示，不能因为进程退出码为 0 而显示绿色成功。
- Worker 离线时，本机命令保持 `queued` 并展示等待原因。
- GitHub dispatch 失败时命令进入 `failed`，允许管理员安全重试；相同幂等键不重复运行。
- 心跳、命令和 Job Run 使用同一个命令关联 ID，后台可以从一次点击追踪到最终业务事实。

## 后台交互约束

- 危险动作采用明确按钮和确认文案，不提供通用命令输入框。
- “重试”默认复用原参数并生成新的命令，JobRunner 通过父运行和命令键保留血缘。
- “取消”只对 `queued` 命令开放。
- Worker 离线时仍允许排队，但 UI 必须说明不会立即执行。
- 凭据健康只展示 `正常|失效|未配置`、最近验证时间和角色名，不展示 DSN。
- 首页优先回答三个问题：数据是否新鲜、哪个链路坏了、现在能否安全重试。

## 测试策略

### 单元测试

- Job 参数白名单与 cron 校验。
- 命令状态机和幂等键。
- Worker 能力白名单。
- 心跳离线判断和 UI 状态映射。
- 凭据切换、回滚和脱敏错误。

### 数据库集成测试

- `FOR UPDATE SKIP LOCKED` 只允许一个 Worker 领取命令。
- 租约超时、已有 Job Run 和重复请求不会重复执行。
- 三类数据库角色只能访问各自允许的数据和操作。
- 暂停、强制执行、调度时间片唯一性和审计记录正确。

### Web 集成测试

- 只读页面正确区分 `success|partial|failed|offline|stale`。
- 修改接口拒绝未知 Job、未知参数、任意命令和未保护请求。
- 手动触发后能从命令追踪到 Job Run。
- 所有响应不包含数据库密码、Token、Cookie 或原始 DSN。

### 真实验收

- 在受保护的 Vercel Ops 中点击一次 X 采集，Mac 在一个轮询周期内领取。
- 三个 X Job 依次产生可归因的 `job_runs`，至少完成一次真实采集、分析和评论检查。
- Mac 离线时命令显示等待；Mac 恢复后命令继续执行。
- 重复点击或刷新请求不会产生重复 Job Run。
- GitHub Job 可以从 Ops 触发，并在 GitHub Actions 中执行而不是占用 Vercel Function。
- 修改一个测试 Job 的调度后，Tick 只在新的到期时间片创建一个命令。

## 实施顺序

1. 在 Node 22 和专用测试数据库下恢复完整测试基线。
2. 修复当前数据库运行时凭证并完成 X 三阶段真实验收。
3. 加固凭证准备、发布事务和 LaunchAgent 安装门禁。
4. 增加 Job 定义、命令、Worker 心跳和审计 Schema，以及最小权限角色。
5. 实现命令服务和 Mac X Worker，先通过 CLI/数据库完成端到端验证。
6. 把现有 Vercel Web Console 合入当前主线基础，增加私有 Ops 页面与 API。
7. 接入 GitHub Workflow dispatch 和固定 Tick。
8. 观察模式对账自动调度，确认无重复和漏跑后移除旧分散 cron。
9. 部署受 Vercel Authentication 保护的独立 Ops Project，完成真实回归。

前五步先交付 X 可用和可靠命令通道；后三步再交付完整 Vercel 维护体验。每一步都必须保持现有 GitHub 潜力榜和 Trending 日/周/月榜可用。

## 基线限制

创建隔离分支时，396 个测试通过；16 个数据库集成套件因未配置 `ACE_TEST_ADMIN_DATABASE_URL` 而在加载阶段停止，没有出现断言失败。当前终端 Node 26 也不满足项目声明的 Node 22 运行范围。实现前必须使用项目的 Node 22 解析脚本，并配置隔离的测试数据库，不能拿生产数据库代替测试库。

## 回滚

- Schema 采用向前兼容的新增表与字段；旧 Workflow 和 LaunchAgent 在新调度稳定前保留。
- Ops 发布失败时回滚 Vercel Deployment，不影响现有自动 Job。
- Worker 失败时恢复旧的定时 X wrapper；命令表保留等待和审计事实。
- 固定 Tick 异常时关闭新调度开关并恢复旧 cron。
- 凭证回滚必须同时验证数据库角色和本地文件一致，不能只恢复文件。
- 所有回滚都不得删除 `job_runs`、`job_commands` 或审计历史。
