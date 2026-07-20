# Ace Hunter 最小 GitHub 信号设计

## 目标

V1 只稳定交付两个独立、事实型能力：

1. 每天采集一次 GitHub Trending 日榜、周榜、月榜，并可通过 Skill 查看。
2. 发现并展示满足“创建 24 小时内且 Star 不少于 10”或“创建 72 小时内且 Star 不少于 100”的潜力仓库。

这两个能力不依赖 X、DeepSeek、Attention Score、日报或实时观察。已有能力继续保留，但不进入本次验收范围。

## 方案选择

采用独立 CLI/Skill 读模型：

- `ace-hunter trending <daily|weekly|monthly|all>` 读取最新完整榜单批次。
- `ace-hunter potential` 读取最新 GitHub Repository 与 Snapshot 事实并现场计算候选规则。

不复用 `today`，避免复杂日报、未来验收数据或 X 状态影响两个最小功能。不新增 HTTP API、数据库表或浏览器界面。

## GitHub Trending

### 采集

- `.github/workflows/trending.yml` 每天 UTC 00:07（北京时间 08:07）执行一次。
- 同一个 Workflow 使用 `fail-fast: false` 的 Daily、Weekly、Monthly matrix Job；任一 period 失败都不能阻止另外两个 period 执行。
- 继续沿用当前 JobRunner 幂等键和 `github_trending_snapshots` 表。
- 每个 period 独立读取；一个 period 没有完整批次时，不影响其他 period。
- Skill 只读取 `language='all'` 的最新可证明完整批次。完整批次要求所有行共享同一个非空 `job_run_id`，对应 JobRun 已在 `now` 前以 `success` 完成、失败数为 0、成功数等于榜单行数，并且同一 `period/language/captured_at` 内全部行 `collection_status='success'`。无 Job 血缘的遗留行不作为稳定榜单来源。
- 新采集失败或只产生 partial 批次时，继续展示上一份完整批次。

### 展示

- 默认 Top 20；`--limit all` 返回完整批次，整数限制为 1–1000。
- `all` 表示一次返回日、周、月三个分区，每个分区分别应用 limit；缺失 period 仍返回该分区并标记 `status='unavailable'`，不静默省略。
- 每个可用分区包含 `period`、`status='available'`、`capturedAt`、`sourceUrl`、`stale` 和有序 `items`。
- `now - capturedAt > 36h` 时 `stale=true`，Markdown 明确标注数据可能过期。
- 每项包含排名、项目名、简介、作者、总 Star、`starsCapturedAt`、周期新增 Star、GitHub URL、Homepage URL。总 Star 只读取不晚于调用 cutoff 的最新 Snapshot，并单独披露其事实时间，不能冒充榜单抓取时刻。
- 结果严格按 rank 升序，不做 AI 排名。

## 潜力项目

### 候选规则

旧规则完全替换为 `candidate-v2`。规则常量和分类函数只定义在一个共享模块中，发现、指标刷新、潜力列表和报告候选必须调用同一个分类函数：

- `age_1d_stars_10`：`0 <= age <= 24h` 且 `stars >= 10`。
- `age_3d_stars_100`：`0 <= age <= 72h` 且 `stars >= 100`。

超过边界 1 毫秒、9 Star 或 99 Star 均不满足相应规则。一个仓库可以同时命中两条规则。

发现 Job 仍每 6 小时运行一次，搜索窗口只保留上述两条规则。新 Snapshot 写入 `candidate_rule_version='v2'`。指标刷新必须用最新 Repository 创建时间与 Star 重新计算 v2 标签，不能复制旧 v1 provenance。报告候选先读取 72 小时最大窗口内的事实，再调用共享分类函数，避免在 SQL 中复制阈值。

### 排除条件

只展示 active、公开事实池中的 primary Repository，并排除 Fork、Archived 和 Mirror。发现阶段继续要求仓库有简介或 README。

### 展示与排序

- 默认 Top 20；`--limit all` 返回全部，整数限制为 1–1000。
- `--rule all|1d|3d`，默认 `all`。
- 每项包含命中规则、创建时间、年龄小时数、Star、平均每小时 Star、Fork、名称、简介、作者、GitHub URL、Homepage URL 和最新采集时间。
- 平均每小时 Star 定义为 `stars / max(ageHours, 1)`。
- 排序依次为平均每小时 Star 降序、Star 降序、创建时间降序、`full_name` 升序。
- 所有判断使用调用时固定的 `now` 和最新可证明 Snapshot，不使用 X 或模型判断。

## CLI 与 Skill

新增命令：

```bash
ace-hunter trending daily --limit 20
ace-hunter trending weekly --limit 20
ace-hunter trending monthly --limit 20
ace-hunter trending all --limit 20
ace-hunter potential --rule all --limit 20
ace-hunter potential --rule 1d --limit all
ace-hunter potential --rule 3d --limit 50
```

默认输出 Markdown，`--format json` 返回稳定结构。参数无效时输出安全错误码并以 1 退出。

Skill 增加以下自然语言路由：

- GitHub 日榜、周榜、月榜、日周月榜。
- 潜力项目、1 天潜力项目、3 天潜力项目。

Skill 只能调用部署管理的 CLI，必须原样保留排名、规则、采集时间、过期标记和来源链接。`trending` 与 `potential` 使用独立只读运行时，只要求 Runtime Database URL；启动这些命令时不得读取 GitHub、X、DeepSeek 或 User ID 凭据。

## 错误处理

- 单 period 没有完整 Trending 批次时返回 `kind=not_found` 和 `reason=trending_unavailable`。`all` 始终返回三个 period 分区并逐项标记 unavailable；三个 period 全不可用时顶层同时标记 `kind=not_found`。
- 没有潜力项目时返回成功的空 `items`，因为“当前没有符合条件的仓库”是有效事实。
- 数据库或配置错误沿用现有安全错误码，不输出凭据或底层异常文本。
- 数值必须是非负安全整数；URL、时间和 limit/rule/period 参数在边界处验证。

## 验收标准

- Behavior：Skill 能查看最新完整 GitHub 日/周/月榜以及 candidate-v2 潜力项目；默认 Top 20，支持整数和 all limit。
- Boundaries：Trending 每天一次；潜力发现每 6 小时；旧 7 天/30 天规则不再参与发现、Snapshot provenance 或报告候选计算；不修改 X、日报、Web 和数据库结构。
- Tests：每项行为先增加失败测试并观察 RED，再实现最小代码；覆盖 24h/72h 毫秒边界、9/10/99/100 Star、双规则命中、确定性排序、完整批次回退、36h stale、CLI 参数和 Skill 文档。
- Verification：完整 `npm test -- --run`、`npm run typecheck`、`npm run lint`、`npm run build`、Skill validator 和 `git diff --check` 通过。
- Live：真实 GitHub Trending 三个独立 matrix period 可采集入 Supabase；部署管理 CLI 与真实 Skill 调用能读取榜单和潜力项目，且输出时间与数据库事实一致。不可变发布切换后的验收必须覆盖全部新命令；任一新命令或 Skill 验收失败时自动恢复前一个 release、wrapper、Skill link 和 LaunchAgent。
- GitHub：在 `codex/minimal-github-signals` 分支提交并推送，创建针对 `main` 的 PR，等待 CI 通过后以 Merge Commit 合并；不直接推送 main。随后从最终 main SHA 创建不可变发布并完成真实 Skill 验收。

## 回滚

代码回滚恢复旧候选规则与旧 Workflow cron，不需要回滚数据库 Schema。历史 `candidate_rule_version='v1'` Snapshot 保留为事实，新读模型按当前 Repository 创建时间和最新 Snapshot 重新计算，因此不会依赖迁移旧行。
