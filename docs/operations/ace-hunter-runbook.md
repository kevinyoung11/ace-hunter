# Ace Hunter 运维手册

本文只记录操作边界和环境变量名，不记录密钥、Cookie、数据库连接串或其他秘密值。生产责任人是运行 `launchd` 的本地 Mac 当前用户；GitHub Actions 负责 GitHub、报告和维护任务，X 数据由该 Mac 的本地 Twitter 会话执行。

## 运行边界

- 数据库使用 Supabase PostgreSQL 14。`ace_hunter_owner` 无登录权限并拥有 `ace_hunter` Schema；`ace_hunter_migrator` 可登录且仅继承 Owner 以执行迁移；`ace_hunter_runtime` 可登录，仅对 Ace Hunter 的九张表拥有 `SELECT/INSERT/UPDATE/DELETE` 和 Schema `USAGE`。Runtime 不能读取 `auth.users`、建 Schema、关闭 RLS 或切换到 Migrator。
- Owner 在外部对象上只拥有 `auth` Schema 的 `USAGE` 和 `auth.users(id)` 的 `REFERENCES`；不得取得 `SELECT`。Public 不得访问 `ace_hunter`。
- GitHub Environment 固定为 `ace-hunter-production`，仅允许 `main`，无审批人和等待时间。它只保存 `ACE_HUNTER_RUNTIME_DATABASE_URL`、`ACE_HUNTER_GITHUB_TOKEN`、`ACE_HUNTER_USER_ID`、`ACE_HUNTER_DEEPSEEK_API_KEY` 四个名称。Migrator、管理员连接和 Twitter 会话不得上传 GitHub。
- 本机 Keychain 使用固定 service/account；调度临时 dotenv 的目录和文件权限分别是 `0700`、`0600`，进程结束或收到信号即删除。日志不得输出环境值、Twitter 内容、Token 或数据库地址。

本地 PostgreSQL 14 验证可用 `brew services list` 检查服务、用 `psql --version` 确认主版本，并以独立测试库执行迁移和集成测试。不要在生产连接上运行测试夹具或清库命令。

## 发布与调度

合并后的 commit SHA 是唯一发布身份。`ops/launchd/deploy-main.sh` 从该 SHA 创建 `${HOME}/Library/Application Support/AceHunter/releases/<sha>` 的不可变 release，构建、校验 Skill 后原子切换 `current`。功能 worktree 可以随后删除，调度器仍只引用不可变 release 中的绝对路径。

GitHub、报告、留存和评估 Job 由 GitHub Actions 执行。X Job 的长期调度器是当前用户 `gui/$UID` 下的 `com.kevinyoung.ace-hunter.collect-x` LaunchAgent：登录时运行，之后每 21600 秒运行一次。机器必须保持登录、开机且可联网；macOS sleep 时不会保证准点运行，唤醒后的延迟应以 `job_runs.scheduled_for` 衡量，不能误判成采集逻辑失败。

`collect-x.yml` 只用于发布验收。`ops/self-hosted-runner/launch-ephemeral.sh <main-sha>` 下载 lock 固定的官方 macOS arm64 Runner、校验 SHA-256、执行构建产物中的 Twitter preflight，注册带 `ace-hunter` 标签的 ephemeral Runner。脚本等待 Runner online 后才触发 Workflow，并按派发时间、此前最大 database ID 和 Main SHA 选择唯一 run；完成后必须看到 Runner 进程退出且 GitHub 端 deregister。

## X 状态与部分失败

产品级 `x_collection_status` 只有四种：`not_collected`（未采集）、`success_with_results`（成功且有结果）、`success_empty`（成功但为零结果）、`unavailable`（失败或来源不可用）。帖子分析过程还会表现为 `pending`、`analyzed` 或 `failed`，详细错误只放在关联 `job_runs`，不把原始模型输出写入日志。

任一批次只有部分对象成功时，Job 必须是 `partial`，并保留成功事实和失败计数；不能伪装成 success。处理顺序是检查根 Job 与按产品拆分的子 Job、确认缺失来源和限流状态、修复认证或依赖，然后用同一可归因入口重跑。不要手工把失败行改成成功。

## 日常检查与故障恢复

1. 查看 GitHub Actions 的 exact-SHA CI 和各 Workflow database ID；数据库侧按 `scheduler_run_id`、`source_job_run_id` 对应，不按“最新一条”猜测。
2. 查看 `${HOME}/Library/Application Support/AceHunter/logs/collect-x.log` 和 `collect-x.error.log`。日志应只有状态、Job ID 和公开计数；若出现秘密值，立即停止 Agent 并按泄露流程轮换。
3. 用 `launchctl print gui/$UID/com.kevinyoung.ace-hunter.collect-x` 确认 Agent 已加载。失败后先修复 Keychain、Twitter 登录、网络或 release，再用 `launchctl kickstart -k gui/$UID/com.kevinyoung.ace-hunter.collect-x` 重试。
4. 若发现 stale lock，仅在确认记录 PID 不属于当前 UID 的同一 wrapper 后由 wrapper 自动恢复；不要在活跃任务期间手工删除 lock。
5. `unavailable` 或重复 `partial` 时，先验证 Twitter preflight、GitHub/DeepSeek 权限和数据库 Runtime 权限，再重跑。公开 X fixture 消失时，必须人工核验并替换公开 ID，不能改用 mock 通过发布验收。

## 密钥与会话生命周期

- GitHub Token 应为只读公开仓库的细粒度 Token；DeepSeek Key、Runtime DSN 和 User ID 仅进入受保护 Environment 与本机 Keychain。轮换时先生成新值、验证权限，再通过 stdin 更新 Keychain 和 GitHub Environment，完成冒烟测试后撤销旧值。失败则恢复旧值并重新验证，禁止半更新。
- 数据库角色密码轮换是单独的管理员操作：在事务化维护窗口更新角色密码、Keychain 和 GitHub Environment，再执行 Schema/Runtime safety check；任何一步失败都回滚到旧凭据。日常 live acceptance 不得旋转角色。
- Twitter 会话只保留在 Runner 所在 Mac。preflight 失败时由机器责任人重新登录并验证版本与 `authenticated=true`，不得复制 Cookie 到仓库、GitHub Secret 或日志。机器退役时先 revoke Twitter session，再删除 Keychain 项。
- 人员或机器权限撤销时，删除四个 Keychain account、撤销 GitHub/DeepSeek Token 和 Twitter session，并从 GitHub 删除仍注册的 self-hosted Runner。

## 升级、回滚与迁移

升级只接受远端 `main` 的准确 SHA。创建并完整验证新不可变 release 后原子切换 `current`，再安装 LaunchAgent。若验收失败，立即把 `current`、CLI wrapper、Skill link 和 LaunchAgent 原子 rollback 到前一个已验证 release；数据库事实不随代码回滚。

数据库迁移只允许 forward-only corrective migration。已经执行的迁移不得修改或降级；发现 Schema 或权限问题时停止发布，新增经过审阅、带校验的向前修正迁移，并重跑 catalog fingerprint、Runtime permission matrix 和端到端验收。

至少保留当前和上一个已验证 release。确认没有进程、`current`、Skill 或 LaunchAgent 引用更老目录后再清理；不得使用宽泛 glob 删除 releases。

## 卸载（uninstall）

先对 `gui/$UID` 执行 `launchctl bootout`，确认无 Ace Hunter 或 Runner 进程，再删除 LaunchAgent。随后撤销 Token/Twitter session、删除固定 Keychain 项、从 GitHub 删除残留 Runner；最后移除 CLI/Skill link、scheduler config、日志和不再引用的不可变 release。数据库保留或删除必须单独审批，卸载脚本不得隐式删除生产数据。
