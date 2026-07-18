import { createHash } from "node:crypto";

export interface CanonicalLimits {
  maxDepth: number;
  maxKeys: number;
  maxArrayElements: number;
  maxNodes: number;
  maxBytes: number;
}

const defaultLimits: CanonicalLimits = {
  maxDepth: 32,
  maxKeys: 10_000,
  maxArrayElements: 10_000,
  maxNodes: 20_000,
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
  validateLimits(bounded);
  if (Object.getPrototypeOf(parameters) !== Object.prototype) {
    throw new Error("Parameters must be a plain JSON object");
  }
  const ancestors = new Set<object>();
  const chunks: string[] = [];
  let keys = 0;
  let arrayElements = 0;
  let nodes = 0;
  let bytes = 0;

  const write = (chunk: string): void => {
    bytes += Buffer.byteLength(chunk, "utf8");
    if (bytes > bounded.maxBytes) throw new Error("JSON byte limit exceeded");
    chunks.push(chunk);
  };
  const visit = (value: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > bounded.maxNodes) throw new Error("JSON node limit exceeded");
    if (depth > bounded.maxDepth) throw new Error("JSON depth limit exceeded");
    if (value === null || typeof value === "boolean" || typeof value === "string") {
      write(JSON.stringify(value));
      return;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Non-finite JSON number");
      write(JSON.stringify(value));
      return;
    }
    if (typeof value !== "object") throw new Error(`Unsupported JSON value: ${typeof value}`);
    if (ancestors.has(value)) throw new Error("Cyclic JSON value");
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("Symbol JSON key");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        arrayElements += value.length;
        if (arrayElements > bounded.maxArrayElements) throw new Error("JSON array limit exceeded");
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const ownNames = Object.getOwnPropertyNames(descriptors);
        if (ownNames.some((name) => {
          if (name === "length") return false;
          const index = Number(name);
          return !Number.isSafeInteger(index) || index < 0 || index >= value.length ||
            String(index) !== name;
        })) throw new Error("Unexpected JSON array property");
        write("[");
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor) throw new Error("Sparse JSON array");
          if (descriptor.get || descriptor.set) throw new Error("JSON accessor property");
          if (!descriptor.enumerable) throw new Error("Non-enumerable JSON array item");
          if (index > 0) write(",");
          visit(descriptor.value, depth + 1);
        }
        write("]");
        return;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error("JSON objects must have the plain object prototype");
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const names = Object.keys(descriptors);
      if (names.some((name) => descriptors[name].get || descriptors[name].set)) {
        throw new Error("JSON accessor property");
      }
      if (names.some((name) => !descriptors[name].enumerable)) {
        throw new Error("Non-enumerable JSON property");
      }
      keys += names.length;
      if (keys > bounded.maxKeys) throw new Error("JSON key limit exceeded");
      names.sort();
      write("{");
      names.forEach((name, index) => {
        if (index > 0) write(",");
        write(JSON.stringify(name));
        write(":");
        visit(descriptors[name].value, depth + 1);
      });
      write("}");
    } finally {
      ancestors.delete(value);
    }
  };

  visit(parameters, 0);
  return chunks.join("");
}

export function jobIdempotencyKeyFromCanonical(
  jobName: string,
  scheduledFor: Date,
  canonicalParameters: string,
): string {
  const digest = createHash("sha256").update(canonicalParameters).digest("hex");
  return `${jobName}:${scheduledFor.toISOString()}:${digest}`;
}

export function jobIdempotencyKey(
  jobName: string,
  scheduledFor: Date,
  parameters: Record<string, unknown>,
): string {
  return jobIdempotencyKeyFromCanonical(
    jobName,
    scheduledFor,
    canonicalJobParameters(parameters),
  );
}

function validateLimits(limits: CanonicalLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid canonical limit");
  }
}
