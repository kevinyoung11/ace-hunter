"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";

export function MonitorManager() {
  const [data, setData] = useState<any>({ loading: true }); const [target, setTarget] = useState("");
  const refresh = () => fetch("/api/monitors").then(async (response) => setData({ response, monitors: (await response.json()).monitors ?? [] })).catch(() => setData({ error: true }));
  useEffect(() => { void refresh(); }, []);
  async function mutate(method: "POST" | "DELETE", value: string) { await fetch("/api/monitors", { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ target: value }) }); setTarget(""); await refresh(); }
  if (data.loading) return <p className="message">正在读取关注列表…</p>;
  return <><form className="command" onSubmit={(event) => { event.preventDefault(); void mutate("POST", target); }}><label htmlFor="monitor-target">添加项目</label><input id="monitor-target" value={target} onChange={(event) => setTarget(event.target.value)} placeholder="owner/repo 或已收录产品名" /><button>关注</button></form><section className="monitor-list">{data.monitors?.length ? data.monitors.map((monitor: any) => <article key={monitor.monitorId}><div><strong>{monitor.name}</strong><span>{monitor.status === "active" ? "关注中" : "已取消"}</span></div>{monitor.status === "active" ? <button onClick={() => void mutate("DELETE", monitor.name)}>取消关注</button> : null}</article>) : <p className="message">还没有关注的项目。</p>}</section></>;
}
