import { guard, output, fail } from "@/lib/ops/http"; import { opsService } from "@/lib/ops/service";
export const runtime="nodejs";
export async function POST(req:Request,{params}:{params:Promise<{name:string}>}){const g=guard(req,true);if(g.response)return g.response;const {name}=await params;try{const b=await req.json() as Record<string,unknown>;return output(await opsService().createCommand(name,b,"ops-api"),g.id,201)}catch{return fail("invalid_job_request",400,g.id)}}
