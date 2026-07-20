"use client";

export function ReportItem({ item, rank }: { item: any; rank: number }) {
  const stars = item.githubFacts?.stars;
  const score = item.score?.attentionScore;
  return <article className="report-item"><div className="rank">{String(rank).padStart(2, "0")}</div><div><div className="item-heading"><h2>{item.name ?? item.productId}</h2>{item.repositoryUrl ? <a href={item.repositoryUrl} target="_blank" rel="noreferrer">GitHub</a> : null}</div><p>{item.conclusion}</p><dl><div><dt>Stars</dt><dd>{typeof stars === "number" ? stars.toLocaleString() : "—"}</dd></div><div><dt>Attention</dt><dd>{typeof score === "number" ? score.toFixed(1) : "—"}</dd></div><div><dt>X</dt><dd>{item.xFacts?.status === "unavailable" ? "不可用" : (item.xFacts?.posts ?? "—")}</dd></div></dl>{item.risks?.length ? <p className="risk">风险：{item.risks.join("；")}</p> : null}</div></article>;
}
