import { guard, output } from "@/lib/ops/http"; import { opsService } from "@/lib/ops/service";
export const runtime="nodejs"; export async function GET(req:Request){const g=guard(req);if(g.response)return g.response;try{return output(await opsService().health(),g.id)}catch{return output({ok:false},g.id,503)}}
