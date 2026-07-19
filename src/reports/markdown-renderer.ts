import type { DailyReport, DailyReportItem, XEvidenceStatus } from "./daily-report.js";
import type { ProductReport } from "./product-report.js";

function display(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function factLines(facts: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(facts).sort().map((key) => `- ${key}：${display(facts[key])}`);
}

function xStatusLine(status: XEvidenceStatus | undefined): string {
  if (status === "unavailable") return "X 数据不可用（不能解释为零讨论）";
  if (status === "success_empty") return "X 检索成功，相关讨论为 0";
  if (status === "partial") return "X 数据部分可用";
  if (status === "success" || status === "success_with_results") return "X 数据可用";
  return "X 数据状态未知";
}

function ranksLine(item: DailyReportItem): string {
  const ranks = item.ranks;
  if (!ranks) return "榜单：—";
  const labels: string[] = [];
  if (ranks.overall != null) labels.push(`总榜 #${ranks.overall}`);
  if (ranks.daily != null) labels.push(`日榜 #${ranks.daily}`);
  if (ranks.weekly != null) labels.push(`周榜 #${ranks.weekly}`);
  if (ranks.monthly != null) labels.push(`月榜 #${ranks.monthly}`);
  return `榜单：${labels.length ? labels.join("；") : "—"}`;
}

function renderItem(item: DailyReportItem, ordinal?: number): string {
  const title = ordinal === undefined ? item.name ?? item.productId : `${ordinal}. ${item.name ?? item.productId}`;
  const repositoryUrl = safeUrl(item.repositoryUrl);
  const homepageUrl = safeUrl(item.homepageUrl);
  const score = item.score.attentionScore;
  const lines = [
    `## ${title}`,
    "",
    `- 数据捕获时间：${item.capturedAt ?? "—"}`,
    `- Attention Score：${display(score)}`,
    `- ${ranksLine(item)}`,
  ];
  if (repositoryUrl) lines.push(`- GitHub：${repositoryUrl}`);
  if (homepageUrl) lines.push(`- 演示网页：${homepageUrl}`);
  lines.push("", "### GitHub 事实", "", ...factLines(item.githubFacts));
  lines.push("", "### X 观察", "", `- ${xStatusLine(item.xFacts.status)}`, "- 情绪（模型判断）：仅在数据可用时作为辅助判断");
  if (item.xFacts.status !== "unavailable") {
    lines.push(...factLines(Object.fromEntries(Object.entries(item.xFacts).filter(([key]) => key !== "status"))));
  }
  lines.push("", "### 代表讨论", "");
  if (item.representativePosts.length === 0) lines.push("- 无可用证据链接");
  else {
    for (const post of item.representativePosts.slice(0, 2)) {
      const url = safeUrl(post.url);
      if (url) lines.push(`- ${post.category}：${url}`);
    }
  }
  lines.push("", "### 结论（模型判断）", "", item.conclusion || "—", "", "### 风险（基于事实）", "");
  if (item.risks.length === 0) lines.push("- 暂无已识别的数据风险");
  else for (const risk of item.risks) lines.push(`- ${risk}`);
  return lines.join("\n");
}

export function renderDailyReport(report: DailyReport): string {
  const lines = [
    "# 今日值得关注",
    "",
    `数据截止时间：${report.dataCutoffAt}`,
    "",
    "## 数据覆盖",
    "",
    `- 扫描仓库：${report.facts.scannedRepos ?? 0}`,
  ];
  for (const [key, value] of Object.entries(report.facts).sort(([left], [right]) => left.localeCompare(right))) {
    if (key !== "scannedRepos") lines.push(`- ${key}：${value}`);
  }
  lines.push("", "## 平台洞察（模型判断，有证据门槛）", "", report.platformSummary ?? "证据不足，暂不生成平台级趋势。", "");
  report.items.forEach((item, index) => lines.push(renderItem(item, index + 1), ""));
  return lines.join("\n").trimEnd() + "\n";
}

export function renderProductReport(report: ProductReport): string {
  const title = report.outputType === "product_analysis" ? "产品离线分析" : "产品实时观察";
  const lines = [
    `# ${title}`,
    "",
    `数据截止时间：${report.dataCutoffAt}`,
    `状态：${report.status}`,
  ];
  if (report.completedSources.length) lines.push(`已完成数据源：${report.completedSources.join("、")}`);
  if (report.missingSources.length) lines.push(`缺失数据源：${report.missingSources.join("、")}`);
  lines.push("", renderItem(report.item));
  return lines.join("\n").trimEnd() + "\n";
}
