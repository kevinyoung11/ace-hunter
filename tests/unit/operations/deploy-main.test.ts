import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("smoke-tests list with its actual option-free CLI contract", async () => {
  const script = await readFile("ops/launchd/deploy-main.sh", "utf8");
  expect(script).toContain('"${candidate}/dist/src/cli/index.js" list >/dev/null');
  expect(script).toContain('"$wrapper" list >/dev/null');
  expect(script).not.toMatch(/\blist --format\b/);
});
