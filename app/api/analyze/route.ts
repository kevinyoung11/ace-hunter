import { authErrorResponse, requireOwner } from "../../../lib/web/auth";
import { failure, output, readTarget } from "../../../lib/web/api";
import { webService } from "../../../lib/web/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    await requireOwner();
    const target = await readTarget(request);
    if (!target) return failure("invalid_target", 400);
    const value = await webService().analyze(target);
    return output(value, value.kind === "not_found" ? 404 : 200);
  } catch (error) { return authErrorResponse(error) ?? failure("command_failed"); }
}
