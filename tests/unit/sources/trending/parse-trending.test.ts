import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseTrending } from "../../../../src/sources/trending/parse-trending.js";

describe("parseTrending", () => {
  it.each([
    ["daily", "owner/repo", 321],
    ["weekly", "owner/week-repo", 1_234],
    ["monthly", "owner/month-repo", 9_876],
  ] as const)("extracts rank, canonical full name, and %s stars", async (period, fullName, stars) => {
    const html = await readFile(`tests/contract/fixtures/trending/${period}.html`, "utf8");
    expect(parseTrending(html, period)).toEqual([{ rank: 1, fullName, starsInPeriod: stars }]);
  });

  it.each([
    ["no rows", "<html><main>changed</main></html>"],
    ["challenge", "<html><title>Sign in to GitHub</title><article class='Box-row'><h2><a href='/a/b'>a/b</a></h2><span class='d-inline-block float-sm-right'>1 star today</span></article></html>"],
    ["external link", "<article class='Box-row'><h2><a href='https://evil.example/a/b'>a/b</a></h2><span class='d-inline-block float-sm-right'>1 star today</span></article>"],
    ["query link", "<article class='Box-row'><h2><a href='/a/b?x=1'>a/b</a></h2><span class='d-inline-block float-sm-right'>1 star today</span></article>"],
    ["missing period stars", "<article class='Box-row'><h2><a href='/a/b'>a/b</a></h2></article>"],
    ["wrong period stars", "<article class='Box-row'><h2><a href='/a/b'>a/b</a></h2><span class='d-inline-block float-sm-right'>1 star this week</span></article>"],
    ["duplicate repo", "<article class='Box-row'><h2><a href='/a/b'>a/b</a></h2><span class='d-inline-block float-sm-right'>1 star today</span></article><article class='Box-row'><h2><a href='/a/b'>a/b</a></h2><span class='d-inline-block float-sm-right'>2 stars today</span></article>"],
  ])("rejects structural breakage: %s", (_name, html) => {
    expect(() => parseTrending(html, "daily")).toThrow(/trending_structure_invalid/);
  });

  it("rejects an unexpectedly large row set", () => {
    const row = "<article class='Box-row'><h2><a href='/a/r'>a/r</a></h2><span class='d-inline-block float-sm-right'>1 star today</span></article>";
    expect(() => parseTrending(row.repeat(101), "daily")).toThrow(/trending_structure_invalid/);
  });

  it.each(["1,00", "9,007,199,254,740,992"])("rejects a non-canonical or unsafe star count: %s", (stars) => {
    const html = `<article class='Box-row'><h2><a href='/a/b'>a/b</a></h2><span class='d-inline-block float-sm-right'>${stars} stars today</span></article>`;
    expect(() => parseTrending(html, "daily")).toThrow(/trending_structure_invalid/);
  });

  it("does not mistake a normal octocaptcha feature flag string for a challenge", () => {
    const html = `<script type='application/json'>{"features":["octocaptcha"]}</script>
      <article class='Box-row'><h2><a href='/a/b'>a/b</a></h2><span class='d-inline-block float-sm-right'>1 star today</span></article>`;
    expect(parseTrending(html, "daily")).toEqual([{ rank: 1, fullName: "a/b", starsInPeriod: 1 }]);
  });

  it("does not mistake GitHub's normal flash-error container for a failed page", () => {
    const html = `<div class='flash-error'></div>
      <article class='Box-row'><h2><a href='/a/b'>a/b</a></h2><span class='d-inline-block float-sm-right'>1 star today</span></article>`;
    expect(parseTrending(html, "daily")).toEqual([{ rank: 1, fullName: "a/b", starsInPeriod: 1 }]);
  });
});
