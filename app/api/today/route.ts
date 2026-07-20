import { authErrorResponse, requireOwner } from "../../../lib/web/auth";
import { failure, output } from "../../../lib/web/api";
import { webService } from "../../../lib/web/service";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireOwner();
    const value = await webService().today();
    return output(value, value.kind === "not_found" ? 404 : 200);
  } catch (error) { return authErrorResponse(error) ?? failure("command_failed"); }
}
