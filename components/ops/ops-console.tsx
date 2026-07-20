"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

export type Job = { name: string; executor: string; capability: string; workflow?: string; enabled: boolean; pausedAt?: string | null };
export type Worker = { worker_id?: string; workerId?: string; executor?: string; capabilities?: string[]; last_seen_at?: string; status?: string };
export type Command = { id: string; jobName?: string; job_name?: string; status: string; executor?: string; capability?: string; scheduledFor?: string | null; scheduled_for?: string | null; };

type LoadState<T> = { state: "loading" | "ready" | "partial" | "offline"; data: T; error?: string; fetchedAt?: Date };

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`/api/ops-ui${path}`, { cache: "no-store", credentials: "same-origin" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.code === "string" ? body.code : `http_${response.status}`);
  return body as T;
}

async function mutate(path: string, action: string): Promise<void> {
  const response = await fetch(`/api/ops-ui${path}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(typeof body.code === "string" ? body.code : `http_${response.status}`); }
}

function StateMessage({ state, error, fetchedAt }: Pick<LoadState<unknown>, "state" | "error" | "fetchedAt">) {
  if (state === "loading") return <p className="message" role="status">正在读取运维状态…</p>;
  if (state === "offline") return <p className="message" role="alert">运维 API 不可用{error ? `（${error}）` : ""}。不会显示或保存任何密钥。</p>;
  if (state === "partial") return <p className="message" role="status">数据部分可用{error ? `：${error}` : ""}。以下内容可能已过期。</p>;
  if (fetchedAt && Date.now() - fetchedAt.getTime() > 120_000) return <p className="message" role="status">数据已超过 2 分钟，正在等待下一次刷新。</p>;
  return null;
}

function OpsNav() {
  return <nav className="ops-nav" aria-label="运维导航"><Link href="/ops">总览</Link><Link href="/ops/jobs">任务</Link><Link href="/ops/workers">Worker</Link><Link href="/ops/sources">数据源</Link><Link href="/ops/audit">审计</Link></nav>;
}

export function OpsFrame({ title, eyebrow, children }: { title: string; eyebrow?: string; children: React.ReactNode }) {
  return <main><header className="topbar"><Link className="brand" href="/">ACE HUNTER / OPS</Link><OpsNav /></header><section className="page-intro"><p>{eyebrow ?? "CONTROL PLANE"}</p><h1>{title}</h1></section>{children}</main>;
}

export function OpsOverview() {
  const [jobs, setJobs] = useState<LoadState<{ jobs: Job[] }>>({ state: "loading", data: { jobs: [] } });
  const [health, setHealth] = useState<LoadState<{ ok?: boolean; database_time?: string }>>({ state: "loading", data: {} });
  const refresh = useCallback(async () => {
    const fetchedAt = new Date();
    const [j, h] = await Promise.allSettled([get<{ jobs: Job[] }>("/jobs"), get<{ ok?: boolean; database_time?: string }>("/health")]);
    setJobs(j.status === "fulfilled" ? { state: "ready", data: j.value, fetchedAt } : { state: "offline", data: { jobs: [] }, error: j.reason instanceof Error ? j.reason.message : "jobs_failed", fetchedAt });
    setHealth(h.status === "fulfilled" ? { state: "ready", data: h.value, fetchedAt } : { state: "partial", data: {}, error: h.reason instanceof Error ? h.reason.message : "health_failed", fetchedAt });
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const enabled = useMemo(() => jobs.data.jobs.filter((j) => j.enabled && !j.pausedAt).length, [jobs.data.jobs]);
  return <OpsFrame title="系统现在是否值得信任？" eyebrow="OPERATIONS OVERVIEW"><section className="ops-grid"><article className="ops-card"><p className="eyebrow">数据库</p><strong className={health.data.ok ? "signal" : "warn"}>{health.state === "ready" && health.data.ok ? "在线" : "不可用"}</strong><StateMessage state={health.state} error={health.error} fetchedAt={health.fetchedAt} /></article><article className="ops-card"><p className="eyebrow">可调度任务</p><strong>{jobs.state === "loading" ? "—" : `${enabled} / ${jobs.data.jobs.length}`}</strong><StateMessage state={jobs.state} error={jobs.error} fetchedAt={jobs.fetchedAt} /></article></section><section className="ops-section"><h2>任务队列入口</h2><p className="summary">在任务页暂停、恢复、手动触发任务；每次改变都要求明确确认，并保留服务端审计记录。</p><p><Link href="/ops/jobs">查看任务控制面板 →</Link></p></section></OpsFrame>;
}

export function OpsJobs() {
  const [result, setResult] = useState<LoadState<{ jobs: Job[] }>>({ state: "loading", data: { jobs: [] } });
  const [busy, setBusy] = useState<string>();
  const refresh = useCallback(async () => { try { setResult({ state: "ready", data: await get<{ jobs: Job[] }>("/jobs"), fetchedAt: new Date() }); } catch (e) { setResult({ state: "offline", data: { jobs: [] }, error: e instanceof Error ? e.message : "jobs_failed", fetchedAt: new Date() }); } }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  async function action(job: Job, actionName: "pause" | "enable" | "run") { if (!window.confirm(`${actionName === "run" ? "立即运行" : actionName === "pause" ? "暂停" : "启用"}任务 ${job.name}？`)) return; setBusy(job.name); try { await mutate(`/jobs/${encodeURIComponent(job.name)}`, actionName); await refresh(); } catch (e) { setResult((old) => ({ ...old, state: "partial", error: e instanceof Error ? e.message : "mutation_failed" })); } finally { setBusy(undefined); } }
  return <OpsFrame title="任务" eyebrow="JOB CONTROL"><StateMessage state={result.state} error={result.error} fetchedAt={result.fetchedAt} /><section className="ops-table" aria-label="任务列表"><div className="ops-row ops-head"><span>任务</span><span>执行器 / 能力</span><span>状态</span><span>操作</span></div>{result.data.jobs.map((job) => <div className="ops-row" key={job.name}><span><Link href={`/ops/jobs/${encodeURIComponent(job.name)}`}>{job.name}</Link></span><span>{job.executor} / {job.capability}</span><span className={job.enabled && !job.pausedAt ? "signal" : "warn"}>{job.pausedAt ? "已暂停" : job.enabled ? "启用" : "禁用"}</span><span className="ops-actions"><button disabled={busy === job.name} onClick={() => void action(job, job.enabled && !job.pausedAt ? "pause" : "enable")}>{job.enabled && !job.pausedAt ? "暂停" : "启用"}</button><button disabled={busy === job.name} onClick={() => void action(job, "run")}>立即运行</button></span></div>)}</section></OpsFrame>;
}

export function OpsJobDetail({ name }: { name: string }) {
  const [job, setJob] = useState<LoadState<Job | null>>({ state: "loading", data: null });
  const [commands] = useState<Command[]>([]);
  useEffect(() => { void get<Job>(`/jobs/${encodeURIComponent(name)}`).then((value) => setJob({ state: "ready", data: value, fetchedAt: new Date() })).catch((e) => setJob({ state: "offline", data: null, error: e instanceof Error ? e.message : "job_failed", fetchedAt: new Date() })); }, [name]);
  return <OpsFrame title={name} eyebrow="JOB DETAIL"><StateMessage state={job.state} error={job.error} fetchedAt={job.fetchedAt} />{job.data && <section className="ops-section"><dl><div><dt>执行器</dt><dd>{job.data.executor}</dd></div><div><dt>能力</dt><dd>{job.data.capability}</dd></div><div><dt>工作流</dt><dd>{job.data.workflow ?? "—"}</dd></div><div><dt>状态</dt><dd>{job.data.enabled && !job.data.pausedAt ? "启用" : "暂停/禁用"}</dd></div></dl><h2>最近命令</h2>{commands.length ? commands.map((command) => <p key={command.id}>{command.id} · {command.status}</p>) : <p className="message">暂无命令记录，或命令读取接口尚未提供。</p>}</section>}</OpsFrame>;
}

export function OpsWorkers() { return <OpsCollection title="Worker" eyebrow="WORKER HEARTBEATS" path="/workers" keyName="workers" empty="没有收到 Worker 心跳；X 链路可能无法运行。" render={(worker: Worker) => <article className="ops-card" key={worker.worker_id ?? worker.workerId}><h2>{worker.worker_id ?? worker.workerId ?? "unknown"}</h2><p>{worker.executor ?? "—"} · {worker.status ?? "在线状态未知"}</p><p className="message">能力：{worker.capabilities?.join(", ") || "—"}</p></article>} />; }
export function OpsSources() { return <OpsCollection title="数据源" eyebrow="SOURCE HEALTH" path="/sources" keyName="sources" empty="没有配置数据源。" render={(source: string) => <article className="ops-card" key={source}><h2>{source}</h2><p className="signal">已配置</p><p className="message">详细延迟与最近成功时间由采集任务写入。</p></article>} />; }
export function OpsAudit() { return <OpsCollection title="审计" eyebrow="AUDIT LOG" path="/audit" keyName="entries" empty="暂无审计记录。" render={(entry: Record<string, unknown>, index) => <article className="ops-card" key={String(entry.id ?? index)}><h2>{String(entry.action ?? "unknown")}</h2><p>{String(entry.actor ?? "system")} · {String(entry.created_at ?? entry.createdAt ?? "—")}</p><p className="message">{entry.job_name ? `任务：${String(entry.job_name)}` : ""}</p></article>} />; }

function OpsCollection<T>({ title, eyebrow, path, keyName, empty, render }: { title: string; eyebrow: string; path: string; keyName: string; empty: string; render: (value: T, index: number) => React.ReactNode }) {
  const [result, setResult] = useState<LoadState<Record<string, T[]>>>({ state: "loading", data: { [keyName]: [] } as Record<string, T[]> });
  useEffect(() => { void get<Record<string, T[]>>(path).then((data) => setResult({ state: "ready", data, fetchedAt: new Date() })).catch((e) => setResult({ state: "offline", data: { [keyName]: [] } as Record<string, T[]>, error: e instanceof Error ? e.message : "request_failed", fetchedAt: new Date() })); }, [path, keyName]);
  const values = result.data[keyName] ?? [];
  return <OpsFrame title={title} eyebrow={eyebrow}><StateMessage state={result.state} error={result.error} fetchedAt={result.fetchedAt} /><section className="ops-grid">{values.length ? values.map(render) : result.state !== "loading" ? <p className="message">{empty}</p> : null}</section></OpsFrame>;
}
