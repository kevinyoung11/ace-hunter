import type { DailyReportItem } from "./daily-report.js";

export type ProductReportOutputType = "product_analysis" | "realtime_observation";
export type ProductReportStatus = "complete" | "partial" | "failed";

export interface ProductReport {
  readonly outputType: ProductReportOutputType;
  readonly dataCutoffAt: string;
  readonly status: ProductReportStatus;
  readonly item: DailyReportItem;
  readonly completedSources: readonly string[];
  readonly missingSources: readonly string[];
}

export interface ProductReportInput {
  readonly outputType: ProductReportOutputType;
  readonly dataCutoffAt: Date;
  readonly status: ProductReportStatus;
  readonly item: DailyReportItem;
  readonly completedSources?: readonly string[];
  readonly missingSources?: readonly string[];
}

export function buildProductReport(input: ProductReportInput): ProductReport {
  if (!Number.isFinite(input.dataCutoffAt.getTime())) throw new Error("dataCutoffAt must be a valid date");
  return {
    outputType: input.outputType,
    dataCutoffAt: input.dataCutoffAt.toISOString(),
    status: input.status,
    item: {
      ...input.item,
      score: { ...input.item.score },
      ranks: input.item.ranks === undefined ? undefined : { ...input.item.ranks },
      githubFacts: { ...input.item.githubFacts },
      xFacts: { ...input.item.xFacts },
      representativePosts: input.item.representativePosts.slice(0, 2).map((post) => ({ ...post })),
      risks: [...input.item.risks],
    },
    completedSources: [...(input.completedSources ?? [])].sort(),
    missingSources: [...(input.missingSources ?? [])].sort(),
  };
}
