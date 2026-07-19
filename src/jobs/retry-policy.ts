import { createHash } from "node:crypto";

export interface CanonicalLimits {
  maxDepth: number;
  maxKeys: number;
  maxArrayElements: number;
  maxNodes: number;
  maxBytes: number;
  maxStringBytes: number;
  maxKeyBytes: number;
}

export interface CanonicalSecurity {
  validateString?(value: string, kind: "key" | "value"): void;
}

const defaultLimits: CanonicalLimits = {
  maxDepth: 32,
  maxKeys: 10_000,
  maxArrayElements: 10_000,
  maxNodes: 20_000,
  maxBytes: 65_536,
  maxStringBytes: 8_192,
  maxKeyBytes: 512,
};

export function retryDelayMs(nextAttempt: number): number | null {
  if (nextAttempt === 1) return 300_000;
  if (nextAttempt === 2) return 1_200_000;
  return null;
}

export function canonicalJobParameters(
  parameters: Record<string, unknown>,
  limits: Partial<CanonicalLimits> = {},
  security: CanonicalSecurity = {},
): string {
  const bounded = { ...defaultLimits, ...limits };
  validateLimits(bounded);
  if (Object.getPrototypeOf(parameters) !== Object.prototype) {
    throw new Error("Parameters must be a plain JSON object");
  }
  const ancestors = new Set<object>();
  const tokens: Array<string | { raw: string }> = [];
  let keys = 0;
  let arrayElements = 0;
  let nodes = 0;
  let bytes = 0;

  const reserve = (byteCount: number): void => {
    bytes += byteCount;
    if (bytes > bounded.maxBytes) throw new Error("JSON byte limit exceeded");
  };
  const write = (chunk: string): void => {
    reserve(Buffer.byteLength(chunk, "utf8"));
    tokens.push(chunk);
  };
  const writeRaw = (value: string, kind: "key" | "value", limit: number): void => {
    validateRawString(value, kind, limit, security);
    reserve(jsonStringByteLength(value));
    tokens.push({ raw: value });
  };
  const visit = (value: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > bounded.maxNodes) throw new Error("JSON node limit exceeded");
    if (depth > bounded.maxDepth) throw new Error("JSON depth limit exceeded");
    if (typeof value === "string") {
      writeRaw(value, "value", bounded.maxStringBytes);
      return;
    }
    if (value === null) {
      write("null");
      return;
    }
    if (typeof value === "boolean") {
      write(value ? "true" : "false");
      return;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Non-finite JSON number");
      write(Object.is(value, -0) ? "0" : String(value));
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
        const ownNames = Object.getOwnPropertyNames(value);
        if (ownNames.some((name) => {
          if (name === "length") return false;
          const index = Number(name);
          return !Number.isSafeInteger(index) || index < 0 || index >= value.length ||
            String(index) !== name;
        })) throw new Error("Unexpected JSON array property");
        write("[");
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
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
      const names = Object.getOwnPropertyNames(value);
      keys += names.length;
      if (keys > bounded.maxKeys) throw new Error("JSON key limit exceeded");
      names.sort();
      write("{");
      names.forEach((name, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!descriptor || descriptor.get || descriptor.set) throw new Error("JSON accessor property");
        if (!descriptor.enumerable) throw new Error("Non-enumerable JSON property");
        if (index > 0) write(",");
        writeRaw(name, "key", bounded.maxKeyBytes);
        write(":");
        visit(descriptor.value, depth + 1);
      });
      write("}");
    } finally {
      ancestors.delete(value);
    }
  };

  visit(parameters, 0);
  return tokens.map((token) => typeof token === "string" ? token : JSON.stringify(token.raw)).join("");
}

function validateRawString(
  value: string,
  kind: "key" | "value",
  maxBytes: number,
  security: CanonicalSecurity,
): void {
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`JSON ${kind} string limit exceeded`);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) {
      throw new Error(`JSON ${kind} contains control characters`);
    }
  }
  security.validateString?.(value, kind);
}

function jsonStringByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += Buffer.byteLength(value[index], "utf8");
    }
  }
  return bytes;
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
