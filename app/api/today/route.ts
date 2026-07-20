import { failure, output } from "../../../lib/web/api";
import { webService } from "../../../lib/web/service";

export const runtime = "nodejs";

export async function GET() {
  try {
    const value = await webService().today();
    return output(value, value.kind === "not_found" ? 404 : 200);
  } catch { return failure("command_failed"); }
}
