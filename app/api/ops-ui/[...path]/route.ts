import { loadOpsConfig } from "../../../../lib/ops/environment";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function forward(request: Request, path: string[]) {
  let config; try { config = loadOpsConfig(); } catch { return Response.json({ code: "ops_not_configured" }, { status: 503 }); }
  const origin = request.headers.get("origin");
  if (origin && origin !== config.ACE_HUNTER_OPS_ORIGIN && origin !== new URL(request.url).origin) return Response.json({ code: "origin_not_allowed" }, { status: 403 });
  const headers = new Headers(request.headers); headers.set("x-ops-token", config.ACE_HUNTER_OPS_API_TOKEN); if (request.method !== "GET") headers.set("x-csrf-token", config.ACE_HUNTER_OPS_API_TOKEN); headers.set("origin", config.ACE_HUNTER_OPS_ORIGIN);
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  return fetch(new URL(`/api/ops/${path.map(encodeURIComponent).join("/")}`, request.url), { method: request.method, headers, body, cache: "no-store" });
}
export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) { return forward(request, (await context.params).path); }
export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) { return forward(request, (await context.params).path); }
