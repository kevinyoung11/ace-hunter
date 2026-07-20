import { failure, output } from "../../../lib/web/api";
import { webService } from "../../../lib/web/service";
import type { TrendingPeriod } from "../../../src/web/stored-facts-service";

export const runtime = "nodejs";

const periods: readonly TrendingPeriod[] = ["daily", "weekly", "monthly"];

export async function GET(request: Request) {
  const period = new URL(request.url).searchParams.get("period") ?? "daily";
  if (!periods.includes(period as TrendingPeriod)) return failure("invalid_period", 400);
  try {
    const value = await webService().trending(period as TrendingPeriod);
    return output(value, value.kind === "not_found" ? 404 : 200);
  } catch { return failure("command_failed"); }
}
