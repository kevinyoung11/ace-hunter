export type TrendingPeriod = "daily" | "weekly" | "monthly";

export interface TrendingEntry {
  rank: number;
  fullName: string;
  starsInPeriod: number;
}

export interface TrendingCollection {
  entries: TrendingEntry[];
  sourceUrl: string;
}

export interface TrendingSource {
  collect(period: TrendingPeriod, language: string): Promise<TrendingCollection>;
}

export class TrendingSourceError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "TrendingSourceError";
  }
}
