export interface ObserveDependencies {
  latestFreshness(productId: string): Promise<{ githubAt: Date | null; xAt: Date | null }>;
  refreshGithub(productId: string, signal: AbortSignal): Promise<unknown>;
  collectX(productId: string, signal: AbortSignal): Promise<unknown>;
  analyzeX(productId: string, collected: unknown, signal: AbortSignal): Promise<unknown>;
  killActiveChildren(): Promise<void>;
  persist(value: ObservationPersistence): Promise<string>;
  enqueueComments(productId: string): Promise<void>;
}

export interface ObservationPersistence {
  readonly outputType: "realtime_observation";
  readonly productId: string;
  readonly dataCutoffAt: Date;
  readonly status: "complete" | "partial";
  readonly completedSources: readonly ObservationSource[];
  readonly missingSources: readonly ObservationSource[];
  readonly github: unknown;
  readonly x: unknown;
}

export type ObservationSource = "github" | "x";
export interface ObservationResult extends ObservationPersistence { readonly observationId: string; }

export async function observeProduct(
  dependencies: ObserveDependencies,
  productId: string,
  options: { deadlineMs: number; now: Date },
): Promise<ObservationResult> {
  validateObservationInput(productId, options);
  const freshness = await dependencies.latestFreshness(productId);
  validateFreshness(freshness);
  const controller = new AbortController();
  const completed = new Set<ObservationSource>();
  const missing = new Set<ObservationSource>();
  const githubFresh = isFresh(freshness.githubAt, options.now, 5 * 60_000);
  const xFresh = isFresh(freshness.xAt, options.now, 15 * 60_000);
  const run = async (source: ObservationSource, work: () => Promise<unknown>): Promise<unknown> => {
    try { const value = await work(); completed.add(source); return value; }
    catch { missing.add(source); return null; }
  };
  const work = Promise.all([
    run("github", () => githubFresh ? Promise.resolve({ freshness: "fresh" }) : dependencies.refreshGithub(productId, controller.signal)),
    run("x", async () => xFresh ? { freshness: "fresh" } : dependencies.analyzeX(productId, await dependencies.collectX(productId, controller.signal), controller.signal)),
  ]);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<[unknown, unknown]>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error("observation_deadline"));
      void dependencies.killActiveChildren().catch(() => undefined).then(() => resolve([null, null]));
    }, options.deadlineMs);
  });
  let sourceValues: [unknown, unknown];
  try {
    sourceValues = await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  for (const source of ["github", "x"] as const) if (!completed.has(source)) missing.add(source);
  const completedSources = (["github", "x"] as const).filter((source) => completed.has(source));
  const missingSources = (["github", "x"] as const).filter((source) => missing.has(source));
  const persistence: ObservationPersistence = {
    outputType: "realtime_observation", productId, dataCutoffAt: new Date(options.now),
    status: missingSources.length > 0 ? "partial" : "complete", completedSources, missingSources,
    github: sourceValues[0], x: sourceValues[1],
  };
  const observationId = await dependencies.persist(persistence);
  if (typeof observationId !== "string" || observationId.length === 0) throw new Error("invalid_observation_id");
  void Promise.resolve().then(() => dependencies.enqueueComments(productId)).catch(() => undefined);
  return { ...persistence, observationId };
}

export interface RegisteredChild {
  once(event: "close", listener: () => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface ProcessRegistry {
  readonly size: number;
  register(child: RegisteredChild): () => void;
  killActiveChildren(): Promise<void>;
}

export function createProcessRegistry(options: { fallbackMs?: number } = {}): ProcessRegistry {
  const fallbackMs = options.fallbackMs ?? 500;
  if (!Number.isInteger(fallbackMs) || fallbackMs < 0 || fallbackMs > 60_000) throw new Error("invalid_process_fallback");
  const children = new Map<RegisteredChild, Promise<void>>();
  return {
    get size() { return children.size; },
    register(child) {
      if (children.has(child)) return () => undefined;
      let closed!: () => void;
      const closedPromise = new Promise<void>((resolve) => { closed = resolve; });
      child.once("close", () => { children.delete(child); closed(); });
      children.set(child, closedPromise);
      return () => { children.delete(child); closed(); };
    },
    async killActiveChildren() {
      await Promise.all([...children].map(async ([child, closed]) => {
        child.kill("SIGTERM");
        let fallback: NodeJS.Timeout | undefined;
        await Promise.race([
          closed,
          new Promise<void>((resolve) => { fallback = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, fallbackMs); }),
        ]);
        if (fallback !== undefined) clearTimeout(fallback);
        await closed;
      }));
    },
  };
}

function isFresh(capturedAt: Date | null, now: Date, maximumAgeMs: number): boolean {
  if (capturedAt === null) return false;
  const age = now.getTime() - capturedAt.getTime();
  return age >= 0 && age <= maximumAgeMs;
}

function validateFreshness(value: { githubAt: Date | null; xAt: Date | null }): void {
  for (const date of [value.githubAt, value.xAt]) if (date !== null && !Number.isFinite(date.getTime())) throw new Error("invalid_freshness");
}

function validateObservationInput(productId: string, options: { deadlineMs: number; now: Date }): void {
  if (productId.trim().length === 0 || productId.length > 256 || /[\r\n]/.test(productId) || !Number.isFinite(options.now.getTime()) || !Number.isInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 300_000) {
    throw new Error("invalid_observation_input");
  }
}
