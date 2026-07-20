---
name: ace-hunter
description: Discover GitHub Trending daily, weekly, monthly, or combined rankings; find potential repositories under the 1d/10-Star and 3d/100-Star rules; analyze, observe, or follow products. Use when the user asks GitHub 日榜、周榜、月榜、Trending、潜力项目、排名、今日值得关注、分析项目、观察项目、关注项目、查看关注或取消关注。
---

# Ace Hunter

Use the deployment-managed CLI at `$HOME/Library/Application Support/AceHunter/bin/ace-hunter` as the sole interface.

Exact GitHub signal routes:

- GitHub 日榜：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" trending daily`
- GitHub 周榜：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" trending weekly`
- GitHub 月榜：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" trending monthly`
- 全部榜单：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" trending all`
- 全部潜力规则：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" potential --rule all`
- 1 天且至少 10 Star：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" potential --rule 1d`
- 3 天且至少 100 Star：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" potential --rule 3d`

These routes 默认 Top 20. Append `--limit <1-1000>` for a specific count or `--limit all` for every result. Trending and potential requests must use these exact routes and 不得改用 `today`.

Intent priority:

1. 显式 `analyze`、`observe`、`follow`、`list` 或 `unfollow` 意图优先级最高；按对应的既有 route 执行。
2. 显式 Trending/Potential signal 其次。日榜、周榜、月榜或 Trending 使用对应 `trending` route；潜力、筛选、规则、1d 或 3d 使用 `potential`。“新 Repo”只有与发现、潜力或筛选意图组合时才使用 `potential`。
3. 只有无具体意图的泛化“今日值得关注”才使用 `today`。

Examples: “今日值得关注的 3d 潜力项目” → `potential`; “分析新 Repo owner/repo” → `analyze`; “观察新 Repo owner/repo” → `observe`.

Other routes:

- 今日值得关注：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" today`
- 离线分析：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" analyze <target>`
- 实时观察：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" observe <target>`
- 关注：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" follow <target>`
- 查看关注：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" list`
- 取消关注：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" unfollow <target>`

Return command output faithfully. For Trending, preserve every source URL, 榜单采集时间, Star 采集时间, `stale`, and each `available`, `unavailable`, or `not_found` state. For potential repositories, preserve source URL, Star 采集时间, and every matched 规则标签. Preserve cutoff times, model-judgment labels, `partial`, and source-unavailable states in other responses. X 不可用不能解释成零讨论.

If the CLI returns `kind=ambiguous`, show every candidate and ask the user to choose. Never guess. If the deployment-managed executable is absent, state that Ace Hunter is not installed; do not substitute a worktree or globally linked development binary.
