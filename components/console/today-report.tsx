"use client";
import { useEffect, useState } from "react";
import { ReportItem } from "./report-item";
import { StatusBadge } from "./status-badge";

export function TodayReport() {
  const [state, setState] = useState<any>({ loading: true });
  useEffect(() => { void fetch("/api/today").then(async (response) => setState({ loading: false, response, data: await response.json() })).catch(() => setState({ loading: false, error: true })); }, []);
  if (state.loading) return <p className="message">正在读取最新日报…</p>;
  if (state.error) return <p className="message">日报暂时无法读取。</p>;
  if (state.response.status === 401) return <p className="message">请先登录。</p>;
  if (state.response.status === 403) return <p className="message">当前账号未被允许访问。</p>;
  if (state.response.status === 404) return <p className="message">暂无可用日报。</p>;
  const report = state.data.content?.report ?? state.data.content ?? state.data;
  return <><section className="page-intro"><p>离线研究报告</p><h1>今日报告</h1><div className="meta"><StatusBadge status={state.data.status ?? report.status} /><span>数据截止 {new Date(state.data.dataCutoffAt ?? report.dataCutoffAt).toLocaleString("zh-CN")}</span></div>{report.platformSummary ? <p className="summary">{report.platformSummary}</p> : null}</section><section className="list">{(report.items ?? []).map((item: any, index: number) => <ReportItem key={item.productId} item={item} rank={index + 1} />)}</section></>;
}
