import { expect, it, vi } from "vitest";
import { selectXBatchProductIds } from "../../../src/cli/job-dispatcher.js";

it.each([
  ["collect", "asc nulls first"],
  ["downstream", "is not null"],
] as const)("bounds and prioritizes the %s X batch", async (phase, phaseSql) => {
  const query = vi.fn().mockResolvedValue({
    rows: Array.from({ length: 79 }, (_, index) => ({ id: `product-${index + 1}` })),
  });

  await expect(selectXBatchProductIds({ query } as never, phase)).resolves.toEqual([
    "product-1",
    "product-2",
    "product-3",
  ]);
  const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
  expect(sql).toContain("user_product_monitors");
  expect(sql).toContain("m.status='active'");
  expect(sql).toContain(phaseSql);
  expect(sql).toContain("limit $1");
  expect(parameters).toEqual([3]);
});
