export const X_ANALYSIS_VERSION = "x-v1" as const;

export interface ContentAnalysisInput {
  id: string;
  text: string;
  authorUsername: string;
}

export interface PostAnalysis {
  postId: string;
  relevanceScore: number;
  topic: string;
  sentiment: "positive" | "neutral" | "negative";
  stance: "support" | "question" | "challenge" | "bug" | "neutral" | "spam";
  automationProbability: number;
  isProjectAffiliated: boolean;
  /** Present on production model results; optional so deterministic test analyzers stay lightweight. */
  analysisVersion?: typeof X_ANALYSIS_VERSION;
  modelName?: string;
}

export interface ContentAnalyzer {
  analyze(posts: ReadonlyArray<ContentAnalysisInput>): Promise<PostAnalysis[]>;
}
