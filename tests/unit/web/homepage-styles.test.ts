import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

describe("homepage responsive styles", () => {
  it("stacks the primary actions at 390px and below", () => {
    expect(stylesheet).toMatch(/@media \(max-width: 390px\) \{[\s\S]*?\.home-actions \{[^}]*flex-direction: column;/);
  });
});
