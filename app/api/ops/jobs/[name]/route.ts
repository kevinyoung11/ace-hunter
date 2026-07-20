import { guard, output, fail } from "@/lib/ops/http"; import { opsService } from "@/lib/ops/service";
export const runtime="nodejs";
export async function GET(req:Request,{params}:{params:Promise<{name:string}>}){const g=guard(req);if(g.response)return g.response;const {name}=await params;try{const job=(await opsService().jobs.list()).find(x=>x.name===name);return job?output(job,g.id):fail("unknown_job",404,g.id)}catch{return fail("ops_database_error",503,g.id)}}
