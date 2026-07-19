import { describe, expect, it } from "vitest";
import { buildProductQueries } from "../../../../src/sources/x/query-builder.js";

describe("buildProductQueries", () => {
  it("orders precise identifiers and never emits a bare generic product name", () => {
    expect(buildProductQueries({
      name: "Open",
      fullName: "o/open",
      repoUrl: "https://github.com/o/open",
      domain: "open.dev",
      isGenericName: true,
    })).toEqual([
      '"https://github.com/o/open"',
      '"o/open"',
      '"open.dev"',
      '"Open" GitHub',
      '"Open" "open source"',
    ]);
  });

  it("omits an absent domain, deduplicates identifiers, and neutralizes query operators in names", () => {
    const queries = buildProductQueries({
      name: 'Tool" OR from:attacker',
      fullName: "tool/tool",
      repoUrl: "https://github.com/tool/tool",
      domain: null,
      isGenericName: false,
    });
    expect(queries).toEqual([
      '"https://github.com/tool/tool"',
      '"tool/tool"',
      '"Tool OR from:attacker" GitHub',
      '"Tool OR from:attacker" "open source"',
    ]);
    expect(queries).not.toContain("Tool");
  });

  it("rejects noncanonical repository identifiers and non-hostname domains", () => {
    expect(() => buildProductQueries({
      name: "Tool",
      fullName: "tool/tool",
      repoUrl: "https://evil.example/tool/tool",
      domain: "tool.dev",
      isGenericName: false,
    })).toThrow(/x_query_invalid/);
    expect(() => buildProductQueries({
      name: "Tool",
      fullName: "tool/tool",
      repoUrl: "https://github.com/tool/tool",
      domain: "https://tool.dev/path",
      isGenericName: false,
    })).toThrow(/x_query_invalid/);
  });
});
