export function StatusBadge({ status, missing }: { status?: string; missing?: readonly string[] }) {
  if (status === "partial") return <span className="status warn">部分数据{missing?.length ? `：${missing.join("、").toUpperCase()} 不可用` : ""}</span>;
  if (status === "complete") return <span className="status good">数据完整</span>;
  return <span className="status">数据不可用</span>;
}
