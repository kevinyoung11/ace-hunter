const sixHoursMs = 6 * 60 * 60 * 1_000;

export function needsAuxRefresh(last: Date | null, now: Date): boolean {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || (last !== null && !Number.isFinite(last.getTime()))) throw new Error("invalid_metric_time");
  return last === null || nowMs - last.getTime() >= sixHoursMs;
}

export function normalizeMetrics(input: { issuesOpen?: number }): { issuesOpen: number | null } {
  if (input.issuesOpen !== undefined && (!Number.isSafeInteger(input.issuesOpen) || input.issuesOpen < 0)) {
    throw new Error("invalid_metric_count");
  }
  return { issuesOpen: input.issuesOpen ?? null };
}
