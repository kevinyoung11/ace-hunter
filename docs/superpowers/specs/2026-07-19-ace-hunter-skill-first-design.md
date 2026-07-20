# Ace Hunter Skill-First 产品设计

日期：2026-07-19
状态：规格已确认

## 1. 产品目标

Ace Hunter 是一个以 Skill 为第一入口的 GitHub 项目发现与观察产品。系统自动采集 GitHub 与 X 数据，离线生成“今日值得关注”报告，并在用户指定项目时执行实时观察。

第一版只解决两个核心任务：

1. 今日有哪些值得关注的产品？
2. 分析、观察或关注某个产品。

其中：

- `Product` 是用户理解和关注的产品实体。
- `Repository` 是 GitHub 指标与 Trending 的采集实体。
- 一个 Product 可以关联多个 Repository。
- 每发现一个新 Repository，系统自动创建一个 Product，并把该 Repository 设为 Primary Repo。
- 第一版不执行任何自动 Product 合并，即使 Owner、名称、官网或 X 账号相同也不自动合并。

## 2. 产品形态

### 2.1 Skill First

用户通过自然语言使用产品，不建设 Web 前端。第一版支持五类意图：

1. `今天有什么值得关注？`
2. `分析 owner/repo` 或 GitHub URL
3. `观察 owner/repo` 或产品名
4. `关注 owner/repo`
5. `查看我的关注`、`取消关注 owner/repo`

语义定义：

- 分析：优先使用最新离线数据，输出完整背景和当前判断。
- 观察：强制触发一次实时刷新，输出当前变化。
- 关注：加入持续采集列表，但第一版不主动提醒。
- 名称匹配多个产品时，不自动猜测，返回候选让用户选择。
- 输入尚未收录的 GitHub URL 时，可以自动创建 Product 和 Repository。

### 2.2 离线报告与实时观察

系统有两条分析链路：

```text
离线链路
定时采集 → 清洗与计算 → 自动生成日报 → Skill 读取

实时链路
用户指定产品 → 刷新 GitHub/X → 即时计算 → Skill 返回
```

Report 是系统离线生成、可重复阅读的内容资产。Observation 是用户触发的实时分析。两者使用同一份底层事实数据，但不混淆产品语义。

## 3. 第一版范围

### 3.1 GitHub 指标

核心指标：

- `github_created_at`
- `stars`

辅助指标：

- `forks`
- `commits_30d`：默认分支最近 30 天 Commit 数
- `pr_total`
- `pr_open`
- `pr_merged`
- `releases_count`
- `latest_release_at`
- `latest_release_tag`
- `issues_total`
- `issues_open`
- `issues_closed`

指标口径：

- `commits_30d` 只统计默认分支、`captured_at` 往前 30 天。
- PR 指标统计仓库全部历史 Pull Requests，`pr_merged` 是已合并子集。
- Issues 指标排除 Pull Requests，避免 GitHub 将 PR 同时视为 Issue 导致重复计数。
- Releases 只统计已发布 Release，不包含 Draft；`latest_release_*` 取最新已发布 Release。

Metadata：

- 项目名称
- 项目简介
- Owner ID、Login、类型和主页
- GitHub 地址
- 演示网页或官网
- 默认分支
- 主要语言
- License
- Topics

第一版不采集 Downloads。GitHub Release Asset 下载量无法代表 npm、PyPI、Docker 或模型下载，跨项目可比性不足。

### 3.2 采集池、日报候选池与评估池

为避免“用户关注”污染全局榜单，第一版明确区分三个集合。

进入采集池的条件满足任意一项即可：

```text
Repo 年龄 ≤ 1 天，stars ≥ 10
Repo 年龄 ≤ 3 天，stars ≥ 100
进入 GitHub 日榜、周榜或月榜
被用户主动关注
```

进入全局日报候选池的条件只包括：两个 candidate-v2“Repo 年龄 + Stars”规则，或进入 GitHub 日榜、周榜、月榜。candidate-v2 的规则标识分别为 `age_1d_stars_10` 与 `age_3d_stars_100`，`candidate_rule_version=v2`。仅因用户关注而进入采集池的 Repo，不自动参与全局 Top 10；当它后来满足公开规则时才参与。

预测效果评估池只包含日报 Top 10 中、报告截止时尚未进入任何 GitHub Trending 周期的 Repo。已经上榜的 Repo 可以出现在“今日值得关注”，但不能被算作“预测成功”。

排除：

- Fork
- Archived Repo
- Mirror
- 仓库不可访问
- 同时缺少简介和 README
- 缺少 `github_created_at` 或 `stars`，导致潜力规则无法计算

第一版不设置自动退出或降频规则。容量按 `repositories` 全部持续追踪记录计数，不按 `status` 过滤；新 Repo 使总数达到 800 个起记录运营告警证据，已有 950 个时新增 Repo 必须携带已审计的非空 `capacity_review_id`，已有 1,000 个时永远拒绝新增。告警的 durable evidence 与 Snapshot 同事务写入 `collected_fields.capacity_status`、`tracked_count`、`capacity_warning`；提交后的结构化日志只是 best-effort，不是通知或 outbox，日志失败不得把已提交的采集标成失败。已有 Repo 无论当前状态为何，都允许刷新、重新激活和修复 Product 关联，且不增加容量计数。

候选发现使用 GitHub Repository Search 的 `created`、`stars`、`is:public`、`archived`、`mirror` 等限定词。GitHub 文档只定义 `fork:true` 与 `fork:only`；默认搜索已排除 Fork，因此不发送未文档化的 `fork:false`，并继续用响应字段二次排除 Fork。由于 REST Search 每次查询最多提供 1,000 条结果，Job 必须按创建时间切片；某个切片的 `total_count > 1,000` 时继续二分时间窗口，直到可完整分页。认证 Search 的独立限额通常为每分钟 30 次，执行前读取 `/rate_limit`，遇到限流按响应头退避，不能通过提高并发硬顶。

### 3.3 GitHub Trending

采集：

- 日榜：`daily`
- 周榜：`weekly`
- 月榜：`monthly`

三个周期使用同一个参数化 Job。第一版采集全站榜，同时在数据结构中保留 `language` 字段，以便以后增加语言榜。

GitHub 官方 Trending 页面提供 Today、This week、This month 三个范围，但公开 REST/GraphQL 文档没有对应端点。第一版采集该页面，随后通过 GitHub API 补充 Repository 数据；页面结构变化属于预期故障，不把它包装成稳定 API。

日报对每个周期使用 `data_cutoff_at` 之前最后一次成功快照。某 Repo 同时出现在多个周期时全部展示，Trending Signal 取最高值。

### 3.4 X 数据

采集与 Product/Repo 相关的原帖和回复：

- 作者信息
- 正文
- 原帖地址
- 发布时间
- 点赞、转发、引用、回复、收藏、浏览量（字段可用时）
- 产品相关性
- 内容主题
- 正向、中性、负向
- 支持、询问、质疑、Bug 反馈、中性、Spam
- 重复内容和自动化概率

情绪、相关性和主题属于模型判断，必须与平台事实分开，并保留 `analysis_version`、`model_name`。

## 4. Jobs 与 Pipeline

第一版有七类 Job：

1. `discover_github_candidates`
2. `collect_github_trending(period)`
3. `refresh_repo_metrics`
4. `collect_x_posts`
5. `analyze_x_posts`
6. `collect_x_comments`
7. `generate_report`

实时观察使用 `observe_product` 编排 GitHub/X 刷新和分析，不作为新的采集事实类型。

### 4.1 调度

```text
发现 GitHub 潜力 Repo：每 6 小时
采集 GitHub Trending：每天 00:07 UTC 采集一次；daily/weekly/monthly 使用互相独立的矩阵实例
刷新已追踪 Repo 核心指标：每 1 小时
在同一个刷新 Job 内补充辅助指标：距上次采集超过 6 小时时刷新
采集 X 原帖：每 6 小时
分析 X 原帖：原帖采集成功后触发
采集 X Comments：原帖分析后触发
生成今日报告：每天 08:30，Asia/Shanghai
实时观察：用户请求时触发
```

`refresh_repo_metrics` 不拆成更多 Job 类型，但按字段分层：Stars、Forks 和基础 Metadata 每小时刷新；Commits、PR、Issues、Releases 最多每 6 小时刷新一次。实时观察只对被点名 Product 的 Primary Repo 强制刷新两层。报告必须携带辅助指标的实际采集时间，不能把沿用值伪装成刚刚采集。

日报数据截止时间为每日 08:00，08:00 至 08:30 用于等待最后一轮采集和分析。

### 4.2 重试

- 第一次失败：5 分钟后重试。
- 第二次失败：20 分钟后重试。
- 最多重试 2 次。
- 部分对象失败时 Job 状态为 `partial`，不能伪装成完整成功。
- 上游部分失败不阻塞整份报告，但报告必须展示数据覆盖率和缺失来源。

## 5. X 采集与清洗规则

### 5.1 搜索优先级

每个 Product 依次使用：

1. 完整 GitHub URL
2. `owner/repo`
3. 官网域名
4. 产品标准名称 + `GitHub`
5. 产品标准名称 + `open source`

产品名过于通用时，禁止使用裸产品名检索。

### 5.2 时间窗口与数量

- 首次发现：回溯最近 7 天。
- 增量采集：从上次成功时间开始，并向前重叠 6 小时。
- 通过 `x_post_id` 去重。
- 每个 Product 每轮最多保存 50 条候选原帖。
- 最多分析 30 条。
- `relevance_score < 0.6` 的内容不进入报告。
- 低热度但高相关内容可以保留。

### 5.3 Comments

- 每个 Product 只处理相关性和热度最高的 Top 5 原帖。
- 每条原帖最多采 20 条 Comments。
- 原帖回复数小于 3 时不采 Comments。
- Comments 不阻塞首次实时观察响应。

### 5.4 去重和异常内容

默认排除 Retweet。完全相同内容、批量模板和明显无关的同名内容不重复进入分析。重复营销内容保留一条代表记录，并记录重复标记。

X 搜索失败时，GitHub 报告继续生成，且明确标记 `x_status=unavailable`。采集失败不得解释成没有讨论。

## 6. 今日 Top 10 排名

### 6.1 原则

确定性数据负责入选和排序；AI 负责解释和分类。情绪、主题和模型摘要不进入主排名。

榜单排序单位是 Product。第一版候选资格、GitHub Momentum 与 Trending Signal 都只取 Product 的 Primary Repo；X Attention 汇总到 Product。Secondary Repo 只作为背景展示，不参与分数，避免一个 Product 因 Repo 数量多而天然占优。

### 6.2 Attention Score

```text
Attention Score =
70% GitHub Momentum
+ 20% X Attention
+ 10% Trending Signal
```

GitHub Momentum 在当日日报候选池内计算：

```text
60% 候选池内 Δstars_24h 百分位
+ 40% 候选池内 star_growth_rate_24h 百分位
```

所有百分位统一使用按指标升序的 `CUME_DIST() × 100`；同值同分，单一候选时为 100。X 百分位只在 X 成功采集的候选中计算。

```text
star_growth_rate_24h =
Δstars_24h / max(24 小时前 stars, 20)
```

X Attention：

```text
50% 相关原帖数百分位
+ 30% 独立作者数百分位
+ 20% 总互动数百分位
```

总互动数：

```text
likes + reposts + quotes + replies + bookmarks
```

X 原帖和 Comments 的“热度”按上述可获得互动数直接从高到低排序，浏览量不参与，以免字段缺失造成不可比。互动相同时优先较新的内容。第一版不另造不可解释的 Heat Score。

Trending Signal：

```text
日榜 100
周榜 70
月榜 40
未上榜 0
```

同时上多个榜时取最高值。

系统历史不足 24 小时时，暂用 `stars / max(repo_age_hours, 6)` 作为 GitHub Momentum 排序依据。拥有 24 小时快照后切换到真实增量。

X 采集失败时，不把 X 分数记为零，而是临时将 GitHub 和 Trending 权重重新归一为 87.5% 与 12.5%。如果成功采集但没有相关帖子，则 X Attention 为零。

## 7. 日报内容

每日只输出 Top 10。

报告顶部展示可验证的数据事实：

- 数据截止时间
- 扫描 Repo 数
- 符合潜力规则 Repo 数
- GitHub 日榜、周榜、月榜项目数
- 有效 X 原帖数
- GitHub/X 数据覆盖率

报告包含一个不超过 200 字的平台趋势摘要。一个趋势至少需要两个 Product 或三个互不隶属于项目方的不同作者支持，否则不得写成平台趋势。

每个项目固定包含：

1. 一句话结论
2. GitHub 事实
3. X 事实
4. 可复算的分数拆解
5. 最多 2 条代表性 X 原帖及地址
6. 风险提示

GitHub 事实至少展示：

- 创建时间
- 当前 Stars
- `Δstars_24h`
- `star_growth_rate_24h`
- Forks
- `commits_30d`
- PR、Issues、Releases
- 日榜、周榜、月榜状态和排名

X 事实至少展示：

- 相关原帖数
- 独立作者数
- 总互动数
- 情绪分布，明确标注为模型判断
- 独立讨论率

代表性 X 内容优先级：

```text
真实使用反馈 > 独立分析 > 项目发布 > 资讯搬运
```

风险提示必须基于已观察事实，例如项目方内容占比高、内容高度重复、Star 增长与开发活动不同步、缺少外部使用证据或数据源不完整。不得把异常直接表述为刷量。

## 8. 实时观察

实时定义为 fresh-on-request，不承诺流式秒级更新。

- 目标响应时间：30 至 90 秒。
- GitHub 数据最大允许陈旧：5 分钟。
- X 数据最大允许陈旧：15 分钟。
- 首次响应不等待 Comments 深度分析。
- 超过 90 秒时返回已完成部分，并明确标注缺失来源。

执行顺序：

```text
用户请求观察
→ 检查新鲜度并刷新 GitHub
→ 搜索最新 X 原帖
→ 分析原帖
→ 返回实时观察结论
```

第一版不做主动提醒、阈值规则和异常推送。“关注”只代表加入用户观察列表并提高持续采集优先级。

## 9. Supabase 与安全边界

### 9.1 数据库

- 使用现有共享 Supabase PostgreSQL。
- Ace Hunter 使用独立 `ace_hunter` Schema。
- 第一版只允许可信 Skill/后台服务访问。
- `ace_hunter` 不暴露给浏览器客户端的 Supabase Data API。
- 数据库配置位于外部 `.env.local`，设计文档和日志不得复制或打印密钥。
- 正式运行使用只拥有 `ace_hunter` 权限的专用数据库角色，避免使用全库管理员账号。
- 所有迁移只允许操作 `ace_hunter.*`，不得修改其他 Schema。

GitHub V0.1 使用独立、只读、可轮换的 Fine-grained Personal Access Token 访问公开仓库，作为服务端 `GITHUB_TOKEN` 保存，不进入数据库或日志。通过字段分层、GraphQL 批量读取和每轮请求预算控制，使当前少于 1,000 个 Repo 的范围保持在 Token 配额内；每轮先保证 Stars 等核心指标，预算不足时延后辅助指标并记录 `partial`。当需要读取私有仓库、多租户授权或更高规模时，再迁移到 GitHub App，第一版不提前承担 App 安装与租户授权复杂度。

### 9.2 规模与保留

第一版持续追踪 Repo 少于 1,000 个，不做表分区。

```text
Repo 小时快照：保留 90 天
90 天以前：每天保留一条
Trending 快照：长期保留
X 原帖与分析：长期保留
Job Runs：保留 90 天
Reports：长期保留
```

## 10. 数据表

第一版使用 9 张表。

### 10.1 `ace_hunter.products`

```text
id UUID PK
name TEXT
description TEXT
website_url TEXT
identifiers JSONB
status TEXT
first_seen_at TIMESTAMPTZ
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

`identifiers` 保存名称、域名、GitHub Full Name 和 X Handle。第一版只用于匹配，不触发自动合并。

Product 同时保存 X 当前采集状态：

```text
x_last_attempted_at TIMESTAMPTZ NULL
x_last_success_at TIMESTAMPTZ NULL
x_collection_status TEXT
x_last_error_code TEXT NULL
```

`x_collection_status` 只允许 `not_collected`、`success_with_results`、`success_empty`、`unavailable`，从而在不增加表的前提下区分“未采集、成功有结果、成功零结果、采集失败”。历史状态冻结在 `analysis_outputs.structured_content`，详细失败留在 `job_runs`。

### 10.2 `ace_hunter.repositories`

```text
id UUID PK
github_repo_id BIGINT UNIQUE
github_node_id TEXT UNIQUE
owner_id BIGINT
owner_login TEXT
owner_type TEXT
owner_profile_url TEXT
owner_avatar_url TEXT
name TEXT
full_name TEXT
description TEXT
repo_url TEXT
homepage_url TEXT
default_branch TEXT
language TEXT
license TEXT
topics JSONB
has_readme BOOLEAN
github_created_at TIMESTAMPTZ
github_pushed_at TIMESTAMPTZ
is_fork BOOLEAN
is_archived BOOLEAN
is_template BOOLEAN
is_mirror BOOLEAN
status TEXT
first_seen_at TIMESTAMPTZ
last_synced_at TIMESTAMPTZ
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

### 10.3 `ace_hunter.product_repositories`

```text
product_id UUID FK
repository_id UUID FK
role TEXT
is_primary BOOLEAN
confidence NUMERIC
link_source TEXT
created_at TIMESTAMPTZ
```

唯一约束为 `(product_id, repository_id)`。每个 Product 最多一个 Primary Repo。

“最多一个 Primary Repo”使用 Partial Unique Index：`UNIQUE (product_id) WHERE is_primary = true`，不能只依赖应用代码。

### 10.4 `ace_hunter.repository_snapshots`

```text
id UUID PK
repository_id UUID FK
captured_at TIMESTAMPTZ
granularity TEXT
stars BIGINT
forks BIGINT
commits_30d INTEGER
pr_total INTEGER
pr_open INTEGER
pr_merged INTEGER
releases_count INTEGER
latest_release_at TIMESTAMPTZ
latest_release_tag TEXT
issues_total INTEGER
issues_open INTEGER
issues_closed INTEGER
aux_metrics_captured_at TIMESTAMPTZ
candidate_buckets TEXT[]
candidate_rule_version TEXT
collected_fields JSONB
created_at TIMESTAMPTZ
```

唯一约束为 `(repository_id, captured_at, granularity)`。`NULL` 表示未采集或失败，`0` 表示成功采集且确认没有数据。

定时快照的 `captured_at` 必须归一为调度时间桶起点：小时快照取整点、日快照取当日零点；同一调度的重试复用同一时间桶。`realtime` 快照才保留实际采集时间。小时快照可以携带最近一次辅助指标值，但必须同时保存原始 `aux_metrics_captured_at`。

### 10.5 `ace_hunter.github_trending_snapshots`

```text
id UUID PK
repository_id UUID FK
period TEXT
language TEXT NOT NULL DEFAULT 'all'
captured_at TIMESTAMPTZ
rank INTEGER
stars_in_period BIGINT
source_url TEXT
collection_status TEXT
job_run_id UUID NULL
created_at TIMESTAMPTZ
```

唯一约束：

- `(period, language, captured_at, repository_id)`
- `(period, language, captured_at, rank)`

### 10.6 `ace_hunter.product_x_posts`

```text
id UUID PK
product_id UUID FK
repository_id UUID NULL
x_post_id TEXT
conversation_id TEXT
root_post_id TEXT
in_reply_to_post_id TEXT
post_type TEXT
author_id TEXT
author_username TEXT
author_name TEXT
author_verified BOOLEAN
content TEXT
language TEXT
post_url TEXT
x_created_at TIMESTAMPTZ
likes BIGINT
reposts BIGINT
quotes BIGINT
replies BIGINT
bookmarks BIGINT NULL
views BIGINT NULL
metrics_updated_at TIMESTAMPTZ
match_method TEXT
matched_identifier TEXT
relation_source TEXT
relevance_score NUMERIC
topic TEXT
sentiment TEXT
stance TEXT
is_duplicate BOOLEAN
duplicate_cluster_id TEXT NULL
automation_probability NUMERIC
is_project_affiliated BOOLEAN
analysis_version TEXT
model_name TEXT
analyzed_at TIMESTAMPTZ
first_seen_at TIMESTAMPTZ
last_synced_at TIMESTAMPTZ
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

唯一约束为 `(product_id, x_post_id)`。Comments 通过 `in_reply_to_post_id IS NOT NULL` 识别。

### 10.7 `ace_hunter.user_product_monitors`

```text
id UUID PK
user_id UUID FK → auth.users.id
product_id UUID FK
status TEXT
started_at TIMESTAMPTZ
last_observed_at TIMESTAMPTZ
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

唯一约束为 `(user_id, product_id)`。

### 10.8 `ace_hunter.analysis_outputs`

```text
id UUID PK
output_type TEXT
user_id UUID NULL
product_id UUID NULL
monitor_id UUID NULL
period_start TIMESTAMPTZ
period_end TIMESTAMPTZ
data_cutoff_at TIMESTAMPTZ
status TEXT
verdict TEXT
confidence NUMERIC
title TEXT
summary TEXT
structured_content JSONB
rendered_markdown TEXT
analysis_version TEXT
model_name TEXT
trigger_type TEXT
idempotency_key TEXT NULL
source_job_run_id UUID NULL
started_at TIMESTAMPTZ
completed_at TIMESTAMPTZ
created_at TIMESTAMPTZ
```

第一版 `output_type` 只使用 `daily_report`、`product_analysis` 和 `realtime_observation`；周报、月报和关注摘要等到实际启用时再增加，避免提前实现空能力。

### 10.9 `ace_hunter.job_runs`

```text
id UUID PK
job_name TEXT
trigger_type TEXT
parent_run_id UUID NULL
scheduled_for TIMESTAMPTZ
parameters JSONB
status TEXT
started_at TIMESTAMPTZ
completed_at TIMESTAMPTZ
data_cutoff_at TIMESTAMPTZ
items_expected INTEGER
items_succeeded INTEGER
items_failed INTEGER
items_skipped INTEGER
failed_items JSONB
error_summary TEXT
attempt INTEGER
next_attempt_at TIMESTAMPTZ NULL
idempotency_key TEXT NOT NULL UNIQUE
created_at TIMESTAMPTZ
```

少量实体级失败放入 `failed_items`。超过 1,000 个持续对象后再评估是否拆分 `job_run_items`。可重试失败先原子写成 `failed`，并把确定的恢复期限写入 `next_attempt_at`；`job_runs_retry_check` 保证该字段只会出现在 `attempt < 2`、已有 `completed_at` 的失败行。进程重启后继续等待剩余时间并恢复同一 Run；提前唤醒或时钟回退保持 Pending，不提前执行。遗留的 `running` 行在获得会话锁后原子消耗下一次 Attempt，Attempt 2 的遗留行直接以 `orphan_retry_exhausted` 终止。因此执行语义明确为 At-least-once，Handler 必须在自己的外部副作用边界保持幂等。

Job Runner 使用两个指向同一 Runtime PostgreSQL 身份、但对象和连接池均独立的 Pool：Lock Pool 的专用 Session 持有 `pg_try_advisory_lock(hashtextextended(...))`，贯穿 Claim、Handler、Retry Sleep 和最终 Unlock；业务 Handler 只使用 Data Pool。Live Duplicate 在当前 Lock Client 上读取并严格核对 Job Name、Trigger、Parent、Schedule、Cutoff 和 Canonical Parameters，不得再次向 Data Pool 借连接。两个 Pool 的安全目标指纹不一致时构造即失败，指纹和错误均不得输出 DSN 或密码。Composition Root 必须给 Runner 显式传入 `loadRedactionRegistry(process.env)` 的结果。

## 11. 关键索引与幂等

关键索引：

```text
repository_snapshots(repository_id, captured_at DESC)
github_trending_snapshots(period, language, captured_at DESC)
github_trending_snapshots(repository_id, captured_at DESC)
product_x_posts(product_id, x_created_at DESC)
product_x_posts(product_id, relevance_score DESC)
user_product_monitors(user_id, status)
analysis_outputs(output_type, period_end DESC)
job_runs(job_name, started_at DESC)
```

幂等键：

```text
Repo 快照：repository_id + captured_at 小时桶 + granularity
Trending：period + language + captured_at 批次 + repository_id
X 内容：product_id + x_post_id
关注：user_id + product_id
全局日报：output_type + period_start + period_end，且 output_type = daily_report、user_id IS NULL
产品分析：output_type + product_id + period_start + period_end，且 output_type = product_analysis
实时观察：idempotency_key，且 output_type = realtime_observation
```

PostgreSQL 中 `NULL` 默认不参与普通唯一冲突，因此三类输出使用各自的 Partial Unique Index，不能依赖一个包含 Nullable 字段的普通唯一约束。`job_runs.idempotency_key` 格式为 `{job_name}:{scheduled_for_utc}:{sha256(canonical_parameters)}`；同一逻辑 Job 的重试更新原行，不创建新的 Job Run。

## 12. 成功指标

### 12.1 数据可靠性

- 日报按时生成率不低于 95%；分母是计划生成的日报数，08:30 后 15 分钟内完成视为按时。
- GitHub 数据覆盖率不低于 98%；分母是进入当日日报候选池的 Repo 数，分子是截止时间前存在 Stars，且存在 24 小时变化数据或满足冷启动回退公式的 Repo 数。
- X 状态必须 100% 区分“没有讨论”“采集失败”“尚未采集”。

### 12.2 X 清洗质量

每周人工抽查 50 条：

- 项目相关性准确率不低于 90%。
- Spam/重复内容识别准确率不低于 85%。
- 情绪判断准确率只记录，第一版不作为上线门槛。

### 12.3 推荐效果

核心指标为无泄漏的 `Pre-Trending Precision@10`：日报 Top 10 中，在报告截止时尚未进入任何 Trending 周期、并在随后 7 天首次进入 GitHub 日榜或周榜的项目比例。若某天符合条件的项目少于 10 个，使用实际项目数作为该日分母。

基线是在同一个评估池内按当前 Stars 排序的 Top 10。运行满 30 天且至少积累 20 个有效日报 cohort 后，比较 Attention Score 与 Stars-only 基线；初版目标是相对提升至少 20%，同时报告绝对百分点差。如果基线为零，只报告绝对差，不宣称相对提升。

记录 Lead Time：项目首次进入今日 Top 10 到首次进入 GitHub Trending 的时间差。前 30 天只记录分布，不预设目标。

### 12.4 用户价值

跟踪：

- Top 10 项目链接点击率
- 报告后继续分析或观察的比例
- 报告后加入关注的比例
- 7 日内重复使用 Skill 的比例

第一版最重要的行为信号是：用户看完报告后，是否继续分析、观察或关注某个项目。

## 13. 非目标

第一版不做：

- Web 前端
- 主动提醒和异常推送
- 用户自定义监控阈值
- Repo 自动退出或降频
- Product 自动合并
- GitHub Downloads
- X 作者影响力图谱
- X 互动历史时间序列
- Product Hunt、Reddit 等其他平台
- 自定义报告和完整运营后台
- 大于 1,000 个 Repo 的规模优化

## 14. 风险与约束

1. X 搜索结果不保证代表全部社区讨论，报告只能表述为“系统采集到的讨论”。
2. 小时快照只能证明两个采样点之间的变化，不能声称精确 Star 事件时间。
3. Product 不自动合并会产生重复实体，但错误合并的伤害更大，第一版接受重复。
4. Trending 页面解析可能变化，失败时必须保留 GitHub API 报告能力并标注数据缺失。
5. AI 情绪和主题判断必须链接回原帖，不得把模型推断呈现为平台事实。
6. 共享 Supabase 中任何越过 `ace_hunter` Schema 的迁移都属于越权操作。
7. V0.1 已选定本机认证的 `twitter-cli 0.8.5` 作为 X Provider，但其授权、速率限制与检索覆盖只在当前本机 Worker 上完成验证；迁移服务器、扩大覆盖或更换 Provider 前必须重新验收，不能把本机条件化 SLA 外推为平台级保证。

## 15. 实施澄清

以下规则来自实施前的约束审查，属于已确认设计的消歧，不扩展产品范围：

1. V0.1 是单用户可信服务，Skill 通过必填 `ACE_HUNTER_USER_ID` 关联现有 `auth.users.id`，不实现注册、登录或自动创建用户。
2. 新 Repo、Product、Primary Repo 关联与首次 Snapshot 必须在同一数据库事务中完成。公开创建 API 接收连接池并自行管理事务，固定先获取全局容量事务锁、再按 `github_repo_id` 获取 64-bit 事务锁；只通过受控事务回调写入首次 Snapshot，不暴露可被误用于自动提交连接的裸事务 primitive。
3. `Δstars_24h` 使用目标时间前后最近快照，允许 90 分钟容差；没有参考快照才进入冷启动公式。
4. GitHub Search 时间切片在同一秒仍超过 1,000 条时，继续按 Stars 范围切片，必须有终止条件并对重叠边界按 `github_repo_id` 去重。
5. X 权重重归一只在本次日报的 X Source 整体不可用时对全榜统一执行；单个 Product 失败不能使用不同权重获得不公平优势，必须保留缺失标记。
6. 定时执行器统一调用可手动运行的 CLI：GitHub/报告/维护 Job 由 GitHub Actions 调度；依赖本机认证会话的 X Job 由当前 Mac 用户的 `launchd` 每 6 小时调度，`collect-x.yml` 只保留发布验收用的手动触发。调度器延迟不等于 Job 逻辑失败，按时率以 `job_runs.scheduled_for` 和实际完成时间计算。
7. V0.1 的真实 X Provider 固定为本机已认证的 `twitter-cli 0.8.5`。Adapter 只允许无 Shell 的子进程调用 `status`、`search`、`article`、`tweet`；Article 壳帖必须展开正文，conversation 只能保存为扁平评论集合，不能伪造回复树。
8. X 的 15 分钟新鲜度只对已通过 `twitter status` 认证检查的本机 Skill Worker 承诺。迁移到服务器或 GitHub-hosted Runner 前必须重新完成认证、速率限制和检索能力验收。
9. 外部 `.env.local` 只能用严格 dotenv 解析器按键读取，禁止通过 Shell `source`/`.` 执行；日志必须屏蔽数据库密码、Authorization、Token 与 Cookie。
10. GitHub Source 以一次发现执行为 Operation 边界：Factory 每次返回独立的请求预算、预检和限流状态，Job 必须关闭 Operation；打开失败映射为安全 JobError，关闭失败不得覆盖已有主错误，只有原执行成功时才转成可重试的安全失败。不得在长寿命共享 Client 上重置全局预算；默认请求预算覆盖最多 1,000 个候选的 Detail 与 README 请求，但仍服从 GitHub `search` 与 `core` 响应头和等待上限。任一成功响应声明对应 Resource 的 Remaining 为 0 时，下一请求前必须等待 Reset 加 1 秒；缺失、未知或非法的耗尽头一律失败关闭。

## 16. 已核验的 GitHub 事实来源

- [GitHub：Repository Search 支持 Stars、Created、Fork、Mirror、Archived 等限定词](https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories)
- [GitHub：REST Search 每次查询最多 1,000 条，认证搜索通常每分钟 30 次](https://docs.github.com/en/rest/search/search)
- [GitHub：REST API 主限额与 Secondary Rate Limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [GitHub Trending 官方页面：Today / This week / This month](https://github.com/trending)
