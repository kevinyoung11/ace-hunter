# Ace Hunter Vercel 单用户 Web 控制台设计

日期：2026-07-20  
状态：已确认，待实施

## 1. 目标与边界

在既有 Skill-first CLI 产品之外，新增一个部署到 Vercel 的私有 Web 控制台，供唯一授权用户浏览日报、分析项目和管理关注列表。

第一期包含：

1. 今日报告：读取最新离线日报并展示排名、结论、证据链接、数据截止时间及部分数据状态。
2. 项目分析：输入 GitHub `owner/repo`、GitHub URL 或已收录产品名，复用现有离线事实生成产品分析报告。
3. 我的关注：读取、添加与取消用户关注。
4. 登录保护：仅允许环境变量配置的一个 Supabase Auth 用户访问。

第一期明确不包含：

- 实时观察（它需要本机 Mac 上的 Twitter 会话与 Worker）。
- 公共访问、注册、多用户或组织/租户能力。
- 浏览器直连 Supabase Database/Data API。
- 改造采集、评分、调度或既有九张业务表。

这份设计是对 `2026-07-19-ace-hunter-skill-first-design.md` 中“第一版不建设 Web 前端”的受控扩展；CLI 仍是完整能力入口。

## 2. 部署与安全架构

```text
Browser
  └─ Supabase Auth session
       └─ Vercel / Next.js App Router
            ├─ 页面（Server Components）
            ├─ Route Handlers（校验 session 与输入）
            └─ 既有领域服务 + PostgreSQL runtime pool
                 └─ ace_hunter schema / analysis outputs / monitors

本机 Mac Worker（保持不变）
  └─ Twitter session、X 采集与既有 launchd 调度
```

Vercel 只在服务端保存下列环境变量：

- `ACE_HUNTER_RUNTIME_DATABASE_URL`
- `ACE_HUNTER_USER_ID`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

其中数据库连接串绝不进入客户端 bundle、日志或响应。浏览器仅携带 Supabase 会话；Route Handler 验证会话中的 `user.id === ACE_HUNTER_USER_ID` 后才能读写业务数据。未认证返回 401，认证但非授权用户返回 403。

不使用 Supabase service role key；不开放 `ace_hunter` schema 给浏览器。现有 `ace_hunter_runtime` 数据库角色仍是唯一的业务读写身份。

## 3. 应用结构

在现有仓库中新增 Next.js App Router，而不是新建独立前端仓库。页面和 API 与领域服务同仓库，避免复制报告 DTO 或让浏览器依赖 CLI 输出文本。

建议目录：

```text
app/
  login/page.tsx
  page.tsx                         # 今日报告
  analyze/page.tsx                 # 项目分析
  monitors/page.tsx                # 我的关注
  api/today/route.ts
  api/analyze/route.ts
  api/monitors/route.ts            # GET / POST / DELETE
components/console/
lib/web/
  auth.ts                          # session + single-user guard
  runtime.ts                       # Vercel runtime dependencies
  dto.ts                           # transport DTO / serialization
```

既有 `src/products/*`、`src/reports/*`、`src/db/*` 是业务实现的唯一来源。Web adapter 可调用这些函数，但不得 shell out 调用 `ace-hunter` CLI；CLI 继续通过同一组服务工作。

## 4. API 契约

所有响应使用 JSON。日期使用 ISO 8601 字符串；数据截止时间和来源缺失状态原样显示，不能被 UI 掩盖。

### `GET /api/today`

复用当前 `today(pool)` 的读取语义，返回最新 `complete` 或 `partial` 的日报。

- `200`：`{ kind: "daily_report", id, status, dataCutoffAt, content }`
- `404`：`{ kind: "not_found", reason: "daily_report_unavailable" }`
- `401` / `403`：未登录或非唯一授权用户。

不向客户端返回 `renderedMarkdown` 作为页面的数据源；页面渲染 `structuredContent` 中的报告字段，避免 Markdown 与 UI 双重解析。

### `POST /api/analyze`

请求：`{ "target": "owner/repo | GitHub URL | 已收录产品名" }`。服务端 trim、限制长度，并用现有 `resolveProduct` 与 `analyzeResolved` 语义处理。

- `200`：`{ kind: "product_analysis", analysisId, status, content }`
- `200`：`{ kind: "ambiguous", candidates }`，让页面列出候选，绝不自动猜测。
- `404`：`{ kind: "not_found", reason }`
- `400`：空值或非法输入。

分析只使用现有离线事实并写入 `analysis_outputs`；不触发 GitHub/X 实时刷新。

### `GET /api/monitors`

复用 `listMonitors(pool, userId)`，只返回配置用户的 active monitors。

### `POST /api/monitors`

请求：`{ "target": "owner/repo | GitHub URL | 已收录产品名" }`。复用现有解析与 `monitorResolved(..., true)`；保持原有审计、幂等与歧义处理语义。

### `DELETE /api/monitors`

请求：`{ "target": "..." }`。复用 `monitorResolved(..., false)`，不删除产品或历史数据。

所有写操作仅在 Route Handler 中执行；前端使用明确的 loading、success、error 和 ambiguous 状态，不做乐观更新直到服务端确认成功。

## 5. 页面与状态

### 今日报告 `/`

默认入口。展示报告日期、`dataCutoffAt`、完整/部分状态、排行项目、核心信号、结论、风险与外部证据链接。没有日报时展示可理解的空状态，不用 Mock 数据替代。

### 项目分析 `/analyze`

输入框提交后调用 API。展示处理中、项目报告、候选选择、未找到、来源不可用和通用失败状态。分析完成后允许用户一键关注，但该操作仍单独调用 monitors API。

### 我的关注 `/monitors`

展示 active monitors 及产品基础信息；支持输入添加、歧义选择、取消关注。取消关注只停用 monitor，因此历史分析仍可读取。

### 登录 `/login`

使用 Supabase Auth 的 magic link 登录。middleware 或服务端 guard 保护控制台路由；授权失败说明“当前账号未被允许访问”，不泄露配置用户 ID。

## 6. 可靠性与 Vercel 约束

- PostgreSQL Pool 采用 Vercel serverless 友好配置，按请求复用模块级 pool；每个 handler 在响应后释放 client。
- `POST /api/analyze` 是基于已落库事实的短事务；若未来耗时超过 Vercel 函数限制，才引入 durable job/轮询，本期不预先增加队列。
- API 和页面将 `partial`、`unavailable`、`not_found`、`ambiguous` 作为一等状态显示。不得把缺失 X 数据显示成零热度。
- 写操作增加请求体上限、目标长度限制和同源 CSRF 保护策略；依赖 Supabase session cookie 的 Route Handler 不接受跨站写入。
- 所有 API 错误对客户端返回安全 code，不返回 DSN、SQL、token、Twitter 内容或内部 stack。

## 7. 改动面评估

| 范围 | 预期改动 | 是否影响既有行为 |
|---|---|---|
| Next.js Web 壳、登录、页面组件 | 新增 | 否 |
| API/BFF 与 DTO 序列化 | 新增 | 否 |
| 既有 CLI 服务抽取/导出 | 小幅重构，以便 Web 与 CLI 共享 | 应以契约测试保证不变 |
| PostgreSQL runtime 连接 | 新增 Vercel adapter 与环境校验 | 否 |
| 日报、分析、关注业务规则 | 复用 | 否 |
| 数据库 schema / migration | 第一阶段不变 | 否 |
| GitHub/X 采集和本机 Worker | 不变 | 否 |

总体改动规模为“中等”：主要工作在安全服务边界、认证与 Web UI；核心业务和数据模型不需要重写。真正会把范围升级为“大”的条件是加入实时观察、公共/多用户访问或把本机 Twitter 会话迁移到云端。

## 8. 验收标准

1. 未登录与非授权账号均不能读取或变更 Ace Hunter 数据。
2. 授权用户可在 Vercel 看到真实最新日报，且 `partial`/来源不可用状态可见。
3. 授权用户可分析 URL、`owner/repo` 与已有产品名；歧义不会自动选中产品。
4. 授权用户可添加、查看和取消关注，且重复操作保持幂等。
5. 浏览器产物和 API 响应中不包含数据库连接、运行时凭据或 Twitter 会话信息。
6. 既有 CLI 命令及其 JSON 合约继续通过测试。
7. 在 Vercel preview 与 production 环境完成构建、鉴权、日报读取、分析、关注/取消关注冒烟验证。
