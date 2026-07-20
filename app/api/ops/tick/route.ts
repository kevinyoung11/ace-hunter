import { guard, output, fail, correlationId } from "@/lib/ops/http"; import { opsService } from "@/lib/ops/service"; import { loadOpsConfig } from "@/lib/ops/environment"; export const runtime="nodejs";
export async function POST(req:Request){
  const id=correlationId(req); const tickSecret=process.env.ACE_HUNTER_OPS_TICK_SECRET;
  const bearer=req.headers.get("authorization");
  const trustedTick=Boolean(tickSecret && bearer===`Bearer ${tickSecret}`);
  const g=trustedTick ? { id } : guard(req,true); if(g.response)return g.response;
  if(!trustedTick && req.headers.get("x-ops-tick-secret")!==tickSecret)return fail("tick_forbidden",403,g.id);
  try { loadOpsConfig(); return output(await opsService().tick(),g.id,202); } catch { return fail("tick_failed",502,g.id); }
}
