"use client";

import { useRef, useState } from "react";

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

const periods: ReadonlyArray<{ value: TrendingPeriod; label: string; emptyLabel: string; numeral: string; starHeading: string }> = [
  { value: "daily", label: "今日", emptyLabel: "暂无今日趋势 Skill。", numeral: "01", starHeading: "Daily stars" },
  { value: "weekly", label: "本周", emptyLabel: "暂无本周趋势 Skill。", numeral: "02", starHeading: "Weekly stars" },
  { value: "monthly", label: "本月", emptyLabel: "暂无本月趋势 Skill。", numeral: "03", starHeading: "Monthly stars" },
];

export function TrendingBoard({ initialItems, initialUnavailable = false }: TrendingBoardProps) {
  const [period, setPeriod] = useState<TrendingPeriod>("daily");
  const [items, setItems] = useState<readonly TrendingSkill[]>(initialItems);
  const [state, setState] = useState<"ready" | "loading" | "error">("ready");
  const [canRetryInitialDaily, setCanRetryInitialDaily] = useState(initialUnavailable);
  const [lastCapturedAt, setLastCapturedAt] = useState(() => latestCapturedAt(initialItems));
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

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
      const nextItems = readTrendingItems(payload);
      setItems(nextItems);
      setLastCapturedAt((current) => latestCapturedAt(nextItems, current));
      setState("ready");
    } catch {
      setItems([]);
      setState("error");
    }
  }

  const selectedPeriod = periods.find((candidate) => candidate.value === period)!;

  function selectTab(index: number) {
    const nextPeriod = periods[index];
    tabRefs.current[index]?.focus();
    void selectPeriod(nextPeriod.value);
  }

  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const nextIndex = event.key === "ArrowRight"
      ? (index + 1) % periods.length
      : event.key === "ArrowLeft"
        ? (index - 1 + periods.length) % periods.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? periods.length - 1
            : undefined;
    if (nextIndex === undefined) return;
    event.preventDefault();
    selectTab(nextIndex);
  }

  return (
    <section id="trending" className="trending-board" aria-labelledby="trending-heading">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Repository momentum</p>
          <h2 id="trending-heading">Skill 趋势榜</h2>
        </div>
        <p className="section-note"><span>按 GitHub 趋势快照排序</span>{lastCapturedAt ? <span>Last captured {formatCapturedAt(lastCapturedAt)}</span> : null}</p>
      </div>
      <div className="period-tabs" aria-label="趋势周期" role="tablist">
        {periods.map((candidate, index) => (
          <button
            aria-controls={`trending-panel-${candidate.value}`}
            aria-selected={candidate.value === period}
            id={`trending-tab-${candidate.value}`}
            key={candidate.value}
            onClick={() => void selectPeriod(candidate.value)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
            ref={(element) => { tabRefs.current[index] = element; }}
            role="tab"
            tabIndex={candidate.value === period ? 0 : -1}
            type="button"
          >
            {candidate.label}
          </button>
        ))}
      </div>
      <div aria-labelledby={`trending-tab-${period}`} id={`trending-panel-${period}`} role="tabpanel" tabIndex={0}>
        <div className="ranking-column-headings">
          <span>{selectedPeriod.numeral}</span><span>Repository</span><span>Language</span><span>{selectedPeriod.starHeading}</span><span>Total stars</span><span>Captured</span>
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
                  <div><dt>{selectedPeriod.starHeading}</dt><dd>{formatPeriodStars(item.starsInPeriod)}</dd></div>
                  <div><dt>Total stars</dt><dd>{formatNumber(item.stars)}</dd></div>
                  <div><dt>Captured</dt><dd>{formatCapturedAt(item.capturedAt)}</dd></div>
                </dl>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
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

function latestCapturedAt(items: readonly TrendingSkill[], previous?: string): string | undefined {
  return [previous, ...items.map((item) => item.capturedAt)]
    .filter((value): value is string => Boolean(value && !Number.isNaN(new Date(value).valueOf())))
    .sort((left, right) => new Date(right).valueOf() - new Date(left).valueOf())[0];
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
