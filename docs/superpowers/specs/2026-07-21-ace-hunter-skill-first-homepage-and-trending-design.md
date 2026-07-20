# Ace Hunter Skill First 官网与 GitHub 榜单设计

日期：2026-07-21  
状态：已确认，待实现

## 目标

将现有 Ace Hunter Web 从“日报控制台首页”调整为 Skill-first 产品官网。首页的首要任务是让用户理解并安装 Ace Hunter Skill；GitHub Trending 日榜、周榜、月榜作为真实内容证明，而不是首页的独立产品入口。

个人日报、项目分析和关注管理继续保留，但迁移到独立控制台入口，不抢占官网首屏。

## 信息架构

### `/`

1. 首屏：产品名、价值主张、安装 Skill 主 CTA、跳转榜单的次 CTA。
2. 今日信号：展示最新 GitHub 日榜第一名的真实仓库名、周期新增 Star、总 Star、语言和采集时间。日榜缺失时显示明确空状态，不伪造项目。
3. GitHub Trending：日榜、周榜、月榜三项切换；默认日榜。每条显示排名、仓库、语言、周期新增 Star、总 Star 和 GitHub 链接。
4. Skill 能力说明：发现项目、分析指定仓库、持续关注。只陈述已有能力，不伪造运行数据。
5. 控制台入口：链接至 `/console`，供已有用户查看日报、分析项目和管理关注。

### `/console`

保留现有控制台入口语义：日报、项目分析、我的关注。原 `/` 日报实现迁移到 `/console`；导航中的“控制台”返回该入口。

## 数据与 API

新增只读接口：`GET /api/trending?period=daily|weekly|monthly`。

它直接读取既有 `ace_hunter.github_trending_snapshots`：

- 选择所请求 period 最新一次 `captured_at` 的记录；按 `rank` 排序。
- 关联已有 repository 与其最新 snapshot，返回 `fullName`、`repoUrl`、`language`、`starsInPeriod`、`stars`、`rank`、`capturedAt`。
- 数据不存在时返回 `{ kind: "not_found", reason: "trending_unavailable", period }` 与 404；不返回 Mock。
- 不触发 GitHub/X 抓取，不新增数据库表或迁移。

首页服务端或客户端调用此接口；日榜第一项复用同一响应。控制台原 API 保持不变。

## 视觉方向

采用 Swiss 风格的研究型产品官网：

- 背景为中性暖白；正文为深墨色；钴蓝是唯一强调色。
- 使用一套无衬线字体、可见的 1px 网格与细分隔线，左对齐、非对称的内容平衡。
- 首屏标题可大，但不使用终端绿、霓虹、光晕、Bento 卡片、渐变或虚构产品插画。
- 排名、Star 和采集时间使用 tabular numerals；榜单是紧凑的编辑式表格，移动端转为纵向条目。
- “今日信号”采用排名数字作为排版主体，而不是圆角卡片。

可见差异化动作：排行榜时间切换会改变左侧的大号 period 数字与榜单列标题，强化“今天 / 本周 / 本月”的编辑节奏。

## 响应式与状态

- 1440px：首屏与榜单采用多列网格，第一名信息与榜单并列。
- 768px：首屏改为单列，榜单仍保持表格列但压缩辅助信息。
- 390px：CTA 纵向排列；榜单转换为每仓库一行的卡片式信息条；切换控件可横向触达。
- loading、空榜、接口失败均显示真实状态文案和最后可用采集时间（若有）；不显示 `Invalid Date`，不把失败渲染成零数据。

## 安全与部署

榜单接口不向客户端返回数据库 DSN、管理员密钥或采集凭据。页面仅消费经过 API 序列化的公开榜单字段。

当前生产环境为保证数据链路可用，服务端运行连接临时使用 Supabase 管理员连接；待 `ace_hunter_runtime` 密码认证问题修复后，应恢复低权限角色连接，不改变 Web API 契约。

## 验收

1. `/` 清晰展示 Skill 安装主 CTA、真实日榜信号和日/周/月榜。
2. 三个周期均从 `github_trending_snapshots` 读取，缺失时显示空状态而非 Mock。
3. `/console` 保留日报、分析、关注入口，且已有 API 不回归。
4. 1440、768、390 宽度无横向溢出，榜单信息可读。
5. `/api/trending` 的输入校验、最新快照选择与空状态有自动化测试。
