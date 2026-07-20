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
