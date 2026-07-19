---
name: ace-hunter
description: Discover today's promising GitHub products, analyze or freshly observe a repository or product, and manage the user's follow list. Use when the user asks 今日值得关注、分析项目、观察项目、关注项目、取消关注或查看关注。
---

# Ace Hunter

Use the deployment-managed CLI at `$HOME/Library/Application Support/AceHunter/bin/ace-hunter` as the sole interface.

- 今日值得关注：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" today`
- 离线分析：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" analyze <target>`
- 实时观察：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" observe <target>`
- 关注：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" follow <target>`
- 查看关注：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" list`
- 取消关注：`"$HOME/Library/Application Support/AceHunter/bin/ace-hunter" unfollow <target>`

Return command output faithfully. Preserve source links, cutoff and capture times, model-judgment labels, `partial`, and source-unavailable states. Never describe unavailable X data as zero discussion.

If the CLI returns `kind=ambiguous`, show every candidate and ask the user to choose. Never guess. If the deployment-managed executable is absent, state that Ace Hunter is not installed; do not substitute a worktree or globally linked development binary.
