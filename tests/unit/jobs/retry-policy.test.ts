import { describe, expect, it, vi } from "vitest";
import {
  canonicalJobParameters,
  jobIdempotencyKey,
  retryDelayMs,
} from "../../../src/jobs/retry-policy.js";

describe("retry policy", () => {
  it("uses exactly two approved retry delays", () => {
    expect([1, 2, 3].map(retryDelayMs)).toEqual([300_000, 1_200_000, null]);
  });

  it("canonicalizes object keys recursively while preserving arrays", () => {
    expect(canonicalJobParameters({ z: [{ b: 2, a: 1 }], a: true })).toBe(
      '{"a":true,"z":[{"a":1,"b":2}]}',
    );
    expect(
      jobIdempotencyKey("job", new Date("2026-07-19T00:00:00Z"), { b: 2, a: 1 }),
    ).toMatch(/^job:2026-07-19T00:00:00\.000Z:[a-f0-9]{64}$/);
  });

  it("is exact for nested order, arrays, names, instants, and non-ASCII", () => {
    const left = canonicalJobParameters({ 雪: "火", nested: { z: 1, a: 2 }, list: [2, 1] });
    const right = canonicalJobParameters({ list: [2, 1], nested: { a: 2, z: 1 }, 雪: "火" });
    expect(left).toBe('{"list":[2,1],"nested":{"a":2,"z":1},"雪":"火"}');
    expect(right).toBe(left);
    expect(canonicalJobParameters({ list: [1, 2] })).not.toBe(canonicalJobParameters({ list: [2, 1] }));
    expect(jobIdempotencyKey("a", new Date("2026-07-19T00:00:00Z"), { 雪: "火" }))
      .toBe("a:2026-07-19T00:00:00.000Z:2e1f004e91e20cdad44ef7d9ce2e82052ef636fd5a704ce37ebe98258622198b");
    expect(jobIdempotencyKey("a", new Date("2026-07-19T00:00:00Z"), { 雪: "火" }))
      .not.toBe(jobIdempotencyKey("b", new Date("2026-07-19T00:00:00Z"), { 雪: "火" }));
    expect(jobIdempotencyKey("a", new Date("2026-07-19T00:00:01Z"), { 雪: "火" }))
      .not.toBe(jobIdempotencyKey("a", new Date("2026-07-19T00:00:00Z"), { 雪: "火" }));
  });

  it.each([
    ["undefined", { value: undefined }],
    ["function", { value: () => 1 }],
    ["symbol", { value: Symbol("x") }],
    ["bigint", { value: 1n }],
    ["nonfinite", { value: Number.NaN }],
    ["custom prototype", Object.create({ inherited: true })],
    ["invalid date", { value: new Date("invalid") }],
  ])("rejects non-JSON input: %s", (_label, value) => {
    expect(() => canonicalJobParameters(value as Record<string, unknown>)).toThrow();
  });

  it("rejects cycles and bounded-resource violations", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJobParameters(cyclic)).toThrow(/cyclic/i);
    expect(() => canonicalJobParameters({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toThrow();
    expect(() => canonicalJobParameters({ a: 1, b: 2 }, { maxKeys: 1 })).toThrow();
    expect(() => canonicalJobParameters({ a: "123" }, { maxBytes: 3 })).toThrow();
    expect(() => canonicalJobParameters({ a: [1, 2] }, { maxArrayElements: 1 })).toThrow();
    expect(() => canonicalJobParameters({ a: { b: 1 } }, { maxNodes: 2 })).toThrow();
  });

  it("rejects symbols, accessors, and sparse arrays without invoking getters", () => {
    const getter = vi.fn(() => "secret");
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: getter });
    expect(() => canonicalJobParameters(accessor)).toThrow(/accessor/i);
    expect(getter).not.toHaveBeenCalled();
    expect(() => canonicalJobParameters({ [Symbol("hidden")]: 1 })).toThrow(/symbol/i);
    const sparse = new Array(2);
    sparse[1] = "x";
    expect(() => canonicalJobParameters({ sparse })).toThrow(/sparse/i);
    const accessorArray = ["safe"];
    Object.defineProperty(accessorArray, "0", { enumerable: true, get: getter });
    expect(() => canonicalJobParameters({ accessorArray })).toThrow(/accessor/i);
    expect(getter).not.toHaveBeenCalled();
    const extra = ["safe"] as string[] & { extra?: string };
    extra.extra = "ignored";
    expect(() => canonicalJobParameters({ extra })).toThrow(/array property/i);
  });
});
