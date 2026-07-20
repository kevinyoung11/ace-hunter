import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

describe("homepage responsive styles", () => {
  it("stacks the primary actions at 390px and below", () => {
    expect(stylesheet).toMatch(/@media \(max-width: 390px\) \{[\s\S]*?\.home-actions \{[^}]*flex-direction: column;/);
  });

  it("uses one desktop grid definition for ranking headers and values", () => {
    expect(stylesheet).toMatch(/\.trending-board \{[^}]*--ranking-tracks:/);
    expect(stylesheet).toMatch(/\.trending-board \{[^}]*--ranking-gap:/);
    expect(stylesheet).toMatch(/\.ranking-column-headings, \.ranking-row \{[^}]*grid-template-columns: var\(--ranking-tracks\);[^}]*gap: var\(--ranking-gap\);/);
    expect(stylesheet).toMatch(/\.ranking-facts \{ display: contents;/);
  });
});
