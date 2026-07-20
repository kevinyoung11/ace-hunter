"use client";

import { useState } from "react";

export type TrendingPeriod = "daily" | "weekly" | "monthly";

export type TrendingSkill = {
  id: string;
  name: string;
  description?: string;
  href?: string;
  rank?: number;
  language?: string;
  starsInPeriod?: number | null;
  stars?: number | null;
  capturedAt?: string;
};

type TrendingBoardProps = {
  initialItems: readonly TrendingSkill[];
  initialUnavailable?: boolean;
};

const periods: ReadonlyArray<{ value: TrendingPeriod; label: string; emptyLabel: string }> = [
  { value: "daily", label: "今日", emptyLabel: "暂无今日趋势 Skill。" },
  { value: "weekly", label: "本周", emptyLabel: "暂无本周趋势 Skill。" },
  { value: "monthly", label: "本月", emptyLabel: "暂无本月趋势 Skill。" },
];

export function TrendingBoard({ initialItems, initialUnavailable = false }: TrendingBoardProps) {
  const [period, setPeriod] = useState<TrendingPeriod>("daily");
  const [items, setItems] = useState<readonly TrendingSkill[]>(initialItems);
  const [state, setState] = useState<"ready" | "loading" | "error">("ready");
  const [canRetryInitialDaily, setCanRetryInitialDaily] = useState(initialUnavailable);

  async function selectPeriod(nextPeriod: TrendingPeriod) {
    if (state === "loading" || (nextPeriod === period && state !== "error" && !(nextPeriod === "daily" && canRetryInitialDaily))) return;

    setPeriod(nextPeriod);
    setState("loading");
    setCanRetryInitialDaily(false);
    try {
      const response = await fetch(`/api/trending?period=${nextPeriod}`);
      const payload: unknown = await response.json();
      if (!response.ok) {
        if (response.status === 404 && isTrendingUnavailable(payload, nextPeriod)) {
          setItems([]);
          setState("ready");
          return;
        }
        throw new Error("trending request failed");
      }
      setItems(readTrendingItems(payload));
      setState("ready");
    } catch {
      setItems([]);
      setState("error");
    }
  }

  const selectedPeriod = periods.find((candidate) => candidate.value === period)!;

  return (
    <section id="trending" className="trending-board" aria-labelledby="trending-heading">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Repository momentum</p>
          <h2 id="trending-heading">Skill 趋势榜</h2>
        </div>
        <p className="section-note">按 GitHub 趋势快照排序</p>
      </div>
      <div className="period-tabs" aria-label="趋势周期" role="tablist">
        {periods.map((candidate) => (
          <button
            aria-pressed={candidate.value === period}
            key={candidate.value}
            onClick={() => void selectPeriod(candidate.value)}
            type="button"
          >
            {candidate.label}
          </button>
        ))}
      </div>
      {state === "loading" ? <p aria-live="polite">正在加载趋势榜…</p> : null}
      {state === "error" ? <p aria-live="polite">趋势榜暂时无法加载，请稍后重试。</p> : null}
      {state === "ready" && items.length === 0 ? <p aria-live="polite">{selectedPeriod.emptyLabel}</p> : null}
      {state === "ready" && items.length > 0 ? (
        <ol className="ranking-list">
          {items.map((item) => (
            <li className="ranking-row" key={item.id}>
              <span className="ranking-rank">#{item.rank ?? "—"}</span>
              <div className="ranking-repository">
                {item.href ? <a href={item.href}>{item.name}</a> : <strong>{item.name}</strong>}
                {item.description && item.description !== item.language ? <p>{item.description}</p> : null}
              </div>
              <dl className="ranking-facts">
                <div><dt>Language</dt><dd>{item.language ?? "—"}</dd></div>
                <div><dt>Period stars</dt><dd>{formatPeriodStars(item.starsInPeriod)}</dd></div>
                <div><dt>Total stars</dt><dd>{formatNumber(item.stars)}</dd></div>
                <div><dt>Captured</dt><dd>{formatCapturedAt(item.capturedAt)}</dd></div>
              </dl>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function readTrendingItems(payload: unknown): TrendingSkill[] {
  const records = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && "items" in payload && Array.isArray(payload.items)
      ? payload.items
      : [];

  return records.flatMap((record) => {
    if (isTrendingSkill(record)) return [record];
    if (isTrendingRepository(record)) {
      return [{
        id: record.fullName,
        name: record.fullName,
        description: record.language,
        href: record.repoUrl,
        rank: record.rank,
        language: record.language,
        starsInPeriod: record.starsInPeriod,
        stars: record.stars,
        capturedAt: record.capturedAt,
      }];
    }
    return [];
  });
}

function isTrendingSkill(value: unknown): value is TrendingSkill {
  return Boolean(
    value
      && typeof value === "object"
      && "id" in value
      && typeof value.id === "string"
      && "name" in value
      && typeof value.name === "string"
      && (!("description" in value) || typeof value.description === "string")
      && (!("href" in value) || typeof value.href === "string"),
  );
}

type TrendingRepository = {
  rank: number;
  fullName: string;
  repoUrl: string;
  language: string;
  starsInPeriod?: number | null;
  stars?: number | null;
  capturedAt?: string;
};

function isTrendingRepository(value: unknown): value is TrendingRepository {
  return Boolean(
    value
      && typeof value === "object"
      && "rank" in value
      && typeof value.rank === "number"
      && "fullName" in value
      && typeof value.fullName === "string"
      && "repoUrl" in value
      && typeof value.repoUrl === "string"
      && "language" in value
      && typeof value.language === "string",
  );
}

export function formatNumber(value: number | null | undefined): string {
  return typeof value === "number" ? value.toLocaleString("en-US") : "—";
}

export function formatPeriodStars(value: number | null | undefined): string {
  return typeof value === "number" ? `${value >= 0 ? "+" : ""}${formatNumber(value)}` : "—";
}

export function formatCapturedAt(value: string | undefined): string {
  const captured = value ? new Date(value) : undefined;
  return captured && !Number.isNaN(captured.valueOf()) ? captured.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—";
}

function isTrendingUnavailable(payload: unknown, period: TrendingPeriod): boolean {
  return Boolean(
    payload
      && typeof payload === "object"
      && "kind" in payload
      && payload.kind === "not_found"
      && "reason" in payload
      && payload.reason === "trending_unavailable"
      && "period" in payload
      && payload.period === period,
  );
}
