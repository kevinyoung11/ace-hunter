import { guard, output, fail, json } from "@/lib/ops/http"; import { opsService } from "@/lib/ops/service";
export const runtime="nodejs";
export async function POST(req:Request,{params}:{params:Promise<{name:string}>}){const g=guard(req,true);if(g.response)return g.response;const {name}=await params;try{const b=await json(req);return output(await opsService().createCommand(name,b,"ops-api"),g.id,201)}catch(e){const tooLarge=e instanceof Error&&e.message==="request_too_large";return fail(tooLarge?"request_too_large":"invalid_job_request",tooLarge?413:400,g.id)}}
