import { authErrorResponse, requireOwner } from "../../../lib/web/auth";
import { failure, output, readTarget } from "../../../lib/web/api";
import { webService } from "../../../lib/web/service";

export const runtime = "nodejs";

export async function GET() {
  try { await requireOwner(); return output(await webService().listMonitors()); }
  catch (error) { return authErrorResponse(error) ?? failure("command_failed"); }
}

export async function POST(request: Request) {
  try {
    await requireOwner();
    const target = await readTarget(request);
    if (!target) return failure("invalid_target", 400);
    return output(await webService().follow(target));
  } catch (error) { return authErrorResponse(error) ?? failure("command_failed"); }
}

export async function DELETE(request: Request) {
  try {
    await requireOwner();
    const target = await readTarget(request);
    if (!target) return failure("invalid_target", 400);
    return output(await webService().unfollow(target));
  } catch (error) { return authErrorResponse(error) ?? failure("command_failed"); }
}
