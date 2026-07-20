import { readFile } from "node:fs/promises";
import { z } from "zod";

const webUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
});
const isoDate = z.string().datetime({ offset: true });
const potentialItem = z.object({
  repositoryId: z.string().min(1), repositoryUrl: webUrl, homepageUrl: webUrl.nullable(),
  createdAt: isoDate, capturedAt: isoDate, stars: z.number().int().nonnegative(),
  matchedRules: z.array(z.enum(["1d", "3d"])).min(1),
}).passthrough();
const potentialSchema = z.object({
  kind: z.literal("potential_repositories"), rule: z.enum(["all", "1d", "3d"]),
  generatedAt: isoDate, items: z.array(potentialItem),
}).passthrough();
const trendingItem = z.object({
  repositoryId: z.string().min(1), rank: z.number().int().positive(), repositoryUrl: webUrl,
  homepageUrl: webUrl.nullable(), starsCapturedAt: isoDate.nullable(),
}).passthrough();
const availableList = z.object({
  period: z.enum(["daily", "weekly", "monthly"]), status: z.literal("available"),
  capturedAt: isoDate, sourceUrl: webUrl, stale: z.boolean(), items: z.array(trendingItem),
}).passthrough();
const unavailableList = z.object({
  period: z.enum(["daily", "weekly", "monthly"]), status: z.literal("unavailable"),
}).passthrough();
const trendingSchema = z.object({
  kind: z.enum(["trending_lists", "not_found"]),
  reason: z.literal("trending_unavailable").optional(),
  period: z.enum(["daily", "weekly", "monthly", "all"]), generatedAt: isoDate,
  lists: z.array(z.union([availableList, unavailableList])),
}).passthrough();

try {
  const paths = process.argv.slice(2);
  if (![5, 7].includes(paths.length) || paths.some((path) => !path.startsWith("/"))) {
    throw new Error("signal_release_usage_error");
  }
  const [potentialPath, dailyPath, weeklyPath, monthlyPath, allPath, skillWeeklyPath, skillPotentialPath] = paths;
  const potential = await parsePotential(potentialPath);
  const daily = await parseTrending(dailyPath, "daily");
  const weekly = await parseTrending(weeklyPath, "weekly");
  const monthly = await parseTrending(monthlyPath, "monthly");
  const all = await parseTrending(allPath, "all");
  if (JSON.stringify(all.lists.map(canonicalList)) !== JSON.stringify([
    ...daily.lists, ...weekly.lists, ...monthly.lists,
  ].map(canonicalList))) throw new Error("trending_all_mismatch");
  if (paths.length === 7) {
    const skillWeekly = await parseTrending(skillWeeklyPath, "weekly");
    const skillPotential = await parsePotential(skillPotentialPath);
    if (JSON.stringify(canonicalTrending(skillWeekly)) !== JSON.stringify(canonicalTrending(weekly))) {
      throw new Error("skill_trending_mismatch");
    }
    if (JSON.stringify(canonicalPotential(skillPotential)) !== JSON.stringify(canonicalPotential(potential))) {
      throw new Error("skill_potential_mismatch");
    }
  }
  process.stdout.write("signal_release_validation_passed\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "signal_release_validation_failed"}\n`);
  process.exitCode = 1;
}

async function parsePotential(path: string) {
  try {
    const value = potentialSchema.parse(JSON.parse((await readFile(path, "utf8")).trim()));
    if (value.rule !== "all") throw new Error();
    return value;
  } catch { throw new Error("invalid_potential_payload"); }
}

async function parseTrending(path: string, expectedPeriod: "daily" | "weekly" | "monthly" | "all") {
  let value: z.infer<typeof trendingSchema>;
  try { value = trendingSchema.parse(JSON.parse((await readFile(path, "utf8")).trim())); }
  catch { throw new Error("invalid_trending_payload"); }
  const expectedSections = expectedPeriod === "all" ? ["daily", "weekly", "monthly"] : [expectedPeriod];
  if (value.period !== expectedPeriod || JSON.stringify(value.lists.map((list) => list.period)) !== JSON.stringify(expectedSections) ||
      (value.kind === "not_found" && (value.reason !== "trending_unavailable" ||
        !value.lists.every((list) => list.status === "unavailable"))) ||
      (value.kind === "trending_lists" && !value.lists.some((list) => list.status === "available"))) {
    throw new Error("invalid_trending_payload");
  }
  return value;
}

function canonicalPotential(value: z.infer<typeof potentialSchema>) {
  return { kind: value.kind, rule: value.rule, items: value.items.map((item) => ({
    repositoryId: item.repositoryId, repositoryUrl: item.repositoryUrl, homepageUrl: item.homepageUrl,
    createdAt: item.createdAt, capturedAt: item.capturedAt, stars: item.stars, matchedRules: item.matchedRules,
  })) };
}

function canonicalTrending(value: z.infer<typeof trendingSchema>) {
  return { kind: value.kind, reason: value.reason ?? null, period: value.period, lists: value.lists.map(canonicalList) };
}

function canonicalList(list: z.infer<typeof availableList> | z.infer<typeof unavailableList>) {
  if (list.status === "unavailable") return { period: list.period, status: list.status };
  return {
    period: list.period, status: list.status, capturedAt: list.capturedAt, sourceUrl: list.sourceUrl,
    stale: list.stale, items: list.items.map((item) => ({
      repositoryId: item.repositoryId, rank: item.rank, repositoryUrl: item.repositoryUrl,
      homepageUrl: item.homepageUrl, starsCapturedAt: item.starsCapturedAt,
    })),
  };
}
