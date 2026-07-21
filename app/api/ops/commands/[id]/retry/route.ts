import { guard, output, fail } from "@/lib/ops/http";
import { opsService } from "@/lib/ops/service";
export const runtime = "nodejs";
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = guard(req, true); if (g.response) return g.response;
  const { id } = await params;
  try { const result = await opsService().retry(id); return result ? output(result, g.id) : fail("command_not_retryable", 409, g.id); }
  catch { return fail("retry_failed", 400, g.id); }
}
