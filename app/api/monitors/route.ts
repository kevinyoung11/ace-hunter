import { failure, output, readTarget } from "../../../lib/web/api";
import { webService } from "../../../lib/web/service";

export const runtime = "nodejs";

export async function GET() {
  try { return output(await webService().listMonitors()); }
  catch { return failure("command_failed"); }
}

export async function POST(request: Request) {
  try {
    const target = await readTarget(request);
    if (!target) return failure("invalid_target", 400);
    return output(await webService().follow(target));
  } catch { return failure("command_failed"); }
}

export async function DELETE(request: Request) {
  try {
    const target = await readTarget(request);
    if (!target) return failure("invalid_target", 400);
    return output(await webService().unfollow(target));
  } catch { return failure("command_failed"); }
}
