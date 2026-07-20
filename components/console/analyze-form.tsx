/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";
import { useState } from "react";
import { ReportItem } from "./report-item";
import { StatusBadge } from "./status-badge";

export function AnalyzeForm() {
  const [target, setTarget] = useState(""); const [state, setState] = useState<any>(null);
  async function submit(value = target) { setState({ loading: true }); const response = await fetch("/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: value }) }); setState({ response, data: await response.json() }); }
  return <><form className="command" onSubmit={(event) => { event.preventDefault(); void submit(); }}><label htmlFor="target">项目</label><input id="target" value={target} onChange={(event) => setTarget(event.target.value)} placeholder="owner/repo 或 GitHub URL" /><button disabled={state?.loading}>分析</button></form>{state?.loading ? <p className="message">正在基于已采集事实生成分析…</p> : null}{state?.response?.status === 404 ? <p className="message">未找到这个项目。仅支持已收录产品。</p> : null}{state?.data?.kind === "ambiguous" ? <section className="choices"><p>找到多个同名项目，请选择：</p>{state.data.candidates.map((candidate: any) => <button key={candidate.id} onClick={() => void submit(candidate.name)}>{candidate.name}</button>)}</section> : null}{state?.data?.content?.report ? <section className="analysis"><StatusBadge status={state.data.status ?? state.data.content.report.status} missing={state.data.content.report.missingSources} /><h2>分析结果</h2><ReportItem item={state.data.content.report.item} rank={1} /></section> : null}</>;
}
