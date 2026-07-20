import { loadOpsConfig } from "../../../../lib/ops/environment";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function forward(request: Request, path: string[]) {
  let config; try { config = loadOpsConfig(); } catch { return Response.json({ code: "ops_not_configured" }, { status: 503 }); }
  const origin = request.headers.get("origin");
  if (origin && origin !== config.ACE_HUNTER_OPS_ORIGIN && origin !== new URL(request.url).origin) return Response.json({ code: "origin_not_allowed" }, { status: 403 });
  const headers = new Headers(request.headers); headers.set("x-ops-token", config.ACE_HUNTER_OPS_API_TOKEN); if (request.method !== "GET") headers.set("x-csrf-token", config.ACE_HUNTER_OPS_API_TOKEN); headers.set("origin", config.ACE_HUNTER_OPS_ORIGIN);
  let body: ArrayBuffer | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > 64 * 1024) return Response.json({ code: "request_too_large" }, { status: 413 });
    const reader = request.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 64 * 1024) { await reader.cancel(); return Response.json({ code: "request_too_large" }, { status: 413 }); } chunks.push(part.value); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } body = bytes.buffer;
    } else { body = await request.arrayBuffer(); if (body.byteLength > 64 * 1024) return Response.json({ code: "request_too_large" }, { status: 413 }); }
  }
  return fetch(new URL(`/api/ops/${path.map(encodeURIComponent).join("/")}`, request.url), { method: request.method, headers, body, cache: "no-store" });
}
export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) { return forward(request, (await context.params).path); }
export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) { return forward(request, (await context.params).path); }
