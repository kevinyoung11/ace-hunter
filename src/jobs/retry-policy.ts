import { createHash } from "node:crypto";

export interface CanonicalLimits {
  maxDepth: number;
  maxKeys: number;
  maxBytes: number;
}

const defaultLimits: CanonicalLimits = {
  maxDepth: 32,
  maxKeys: 10_000,
  maxBytes: 65_536,
};

export function retryDelayMs(nextAttempt: number): number | null {
  if (nextAttempt === 1) return 300_000;
  if (nextAttempt === 2) return 1_200_000;
  return null;
}

export function canonicalJobParameters(
  parameters: Record<string, unknown>,
  limits: Partial<CanonicalLimits> = {},
): string {
  const bounded = { ...defaultLimits, ...limits };
  const ancestors = new Set<object>();
  let keyCount = 0;

  const visit = (value: unknown, depth: number): unknown => {
    if (depth > bounded.maxDepth) throw new Error("JSON depth limit exceeded");
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Non-finite JSON number");
      return value;
    }
    if (typeof value !== "object") throw new Error(`Unsupported JSON value: ${typeof value}`);
    if (ancestors.has(value)) throw new Error("Cyclic JSON value");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
      if (Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error("JSON objects must have the plain object prototype");
      }
      const result: Record<string, unknown> = {};
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      keyCount += entries.length;
      if (keyCount > bounded.maxKeys) throw new Error("JSON key limit exceeded");
      for (const [key, child] of entries) result[key] = visit(child, depth + 1);
      return result;
    } finally {
      ancestors.delete(value);
    }
  };

  if (Object.getPrototypeOf(parameters) !== Object.prototype) {
    throw new Error("Parameters must be a plain JSON object");
  }
  const serialized = JSON.stringify(visit(parameters, 0));
  if (Buffer.byteLength(serialized, "utf8") > bounded.maxBytes) {
    throw new Error("JSON byte limit exceeded");
  }
  return serialized;
}

export function jobIdempotencyKey(
  jobName: string,
  scheduledFor: Date,
  parameters: Record<string, unknown>,
): string {
  const canonical = canonicalJobParameters(parameters);
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `${jobName}:${scheduledFor.toISOString()}:${digest}`;
}
