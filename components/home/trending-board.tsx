"use client";

import { useState } from "react";

export type TrendingPeriod = "daily" | "weekly" | "monthly";

export type TrendingSkill = {
  id: string;
  name: string;
  description?: string;
  href?: string;
};

type TrendingBoardProps = {
  initialItems: readonly TrendingSkill[];
};

const periods: ReadonlyArray<{ value: TrendingPeriod; label: string; emptyLabel: string }> = [
  { value: "daily", label: "今日", emptyLabel: "暂无今日趋势 Skill。" },
  { value: "weekly", label: "本周", emptyLabel: "暂无本周趋势 Skill。" },
  { value: "monthly", label: "本月", emptyLabel: "暂无本月趋势 Skill。" },
];

export function TrendingBoard({ initialItems }: TrendingBoardProps) {
  const [period, setPeriod] = useState<TrendingPeriod>("daily");
  const [items, setItems] = useState<readonly TrendingSkill[]>(initialItems);
  const [state, setState] = useState<"ready" | "loading" | "error">("ready");

  async function selectPeriod(nextPeriod: TrendingPeriod) {
    if (nextPeriod === period || state === "loading") return;

    setPeriod(nextPeriod);
    setState("loading");
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
    <section id="trending" aria-labelledby="trending-heading">
      <h2 id="trending-heading">Skill 趋势榜</h2>
      <div aria-label="趋势周期">
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
        <ol>
          {items.map((item) => (
            <li key={item.id}>
              {item.href ? <a href={item.href}>{item.name}</a> : <strong>{item.name}</strong>}
              {item.description ? <p>{item.description}</p> : null}
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
  fullName: string;
  repoUrl: string;
  language: string;
};

function isTrendingRepository(value: unknown): value is TrendingRepository {
  return Boolean(
    value
      && typeof value === "object"
      && "fullName" in value
      && typeof value.fullName === "string"
      && "repoUrl" in value
      && typeof value.repoUrl === "string"
      && "language" in value
      && typeof value.language === "string",
  );
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
