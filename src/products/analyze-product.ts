export interface OfflineProductFacts {
  readonly completedSources?: readonly string[];
  readonly missingSources?: readonly string[];
  readonly [key: string]: unknown;
}

export interface ProductAnalysisPersistence {
  readonly outputType: "product_analysis";
  readonly productId: string;
  readonly dataCutoffAt: Date;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly status: "complete" | "partial";
  readonly facts: OfflineProductFacts;
}

export interface AnalyzeProductDependencies {
  loadLatestFacts(productId: string, cutoff: Date): Promise<OfflineProductFacts | null>;
  persistAnalysis(input: ProductAnalysisPersistence): Promise<string>;
}

export type AnalyzeProductResult =
  | { kind: "created"; analysisId: string; status: "complete" | "partial" }
  | { kind: "not_found" };

export async function analyzeProduct(
  dependencies: AnalyzeProductDependencies,
  productId: string,
  options: { now: Date },
): Promise<AnalyzeProductResult> {
  assertInput(productId, options.now);
  const facts = await dependencies.loadLatestFacts(productId, new Date(options.now));
  if (facts === null) return { kind: "not_found" };
  const frozenFacts = structuredClone(facts);
  const missing = Array.isArray(frozenFacts.missingSources) ? frozenFacts.missingSources : [];
  const status = missing.length > 0 ? "partial" as const : "complete" as const;
  const cutoff = new Date(options.now);
  const analysisId = await dependencies.persistAnalysis({
    outputType: "product_analysis",
    productId,
    dataCutoffAt: cutoff,
    periodStart: cutoff,
    periodEnd: cutoff,
    status,
    facts: frozenFacts,
  });
  if (typeof analysisId !== "string" || analysisId.length === 0) throw new Error("invalid_analysis_id");
  return { kind: "created", analysisId, status };
}

function assertInput(productId: string, now: Date): void {
  if (productId.trim().length === 0 || productId.length > 256 || /[\r\n]/.test(productId) || !Number.isFinite(now.getTime())) {
    throw new Error("invalid_product_analysis_input");
  }
}
