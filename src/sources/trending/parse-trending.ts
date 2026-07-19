import { load } from "cheerio";
import type { TrendingEntry, TrendingPeriod } from "./trending-source.js";
import { TrendingSourceError } from "./trending-source.js";

const fullNamePattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const periodLabel: Record<TrendingPeriod, string> = {
  daily: "today",
  weekly: "this week",
  monthly: "this month",
};

export function parseTrending(html: string, period: TrendingPeriod): TrendingEntry[] {
  if (!html || html.length > 5_000_000) invalid();
  const $ = load(html);
  const title = $("title").text().trim().toLowerCase();
  if (/sign in to github|rate limit|security verification|unicorn/.test(title) || $("[data-captcha-url]").length > 0) invalid();
  const articles = $("article.Box-row");
  if (articles.length === 0 || articles.length > 100) invalid();
  const seen = new Set<string>();
  return articles.toArray().map((node, index) => {
    const links = $(node).find("h2 a");
    if (links.length !== 1) invalid();
    const href = links.attr("href");
    if (!href || href.length > 513 || !href.startsWith("/") || href.startsWith("//") || href.includes("?") || href.includes("#")) invalid();
    const fullName = href.slice(1);
    if (!fullNamePattern.test(fullName) || fullName.length > 512) invalid();
    const identity = fullName.toLowerCase();
    if (seen.has(identity)) invalid();
    seen.add(identity);

    const expected = periodLabel[period];
    const starTexts = $(node).find("span.d-inline-block.float-sm-right").toArray()
      .map((element) => $(element).text().replace(/\s+/g, " ").trim())
      .filter((text) => text.toLowerCase().endsWith(expected));
    if (starTexts.length !== 1) invalid();
    const match = new RegExp(`^([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)\\s+stars?\\s+${escapeRegex(expected)}$`, "i").exec(starTexts[0]);
    if (!match) invalid();
    const starsInPeriod = Number(match[1].replaceAll(",", ""));
    if (!Number.isSafeInteger(starsInPeriod) || starsInPeriod < 0) invalid();
    return { rank: index + 1, fullName, starsInPeriod };
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function invalid(): never {
  throw new TrendingSourceError("trending_structure_invalid");
}
