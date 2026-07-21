import { guard, output, fail } from "@/lib/ops/http"; import { opsService } from "@/lib/ops/service";
export const runtime="nodejs";
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}){const g=guard(req,true);if(g.response)return g.response;const {id}=await params;try{const c=await opsService().commands.call("cancel_job_command",[id,"ops-api"]);return c?output(c,g.id):fail("command_not_cancellable",409,g.id)}catch{return fail("cancel_failed",400,g.id)}}
