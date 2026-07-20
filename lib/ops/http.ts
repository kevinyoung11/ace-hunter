import { NextResponse } from "next/server";
import { loadOpsConfig } from "./environment";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function correlationId(req: Request): string { return req.headers.get("x-correlation-id")?.slice(0,128) || crypto.randomUUID(); }
export function guard(req: Request, mutate = false): { response?: NextResponse; id: string } {
  const id = correlationId(req); let cfg;
  try { cfg = loadOpsConfig(); } catch { return { response: fail("ops_not_configured", 503, id), id }; }
  const origin = req.headers.get("origin");
  if (origin && origin !== cfg.ACE_HUNTER_OPS_ORIGIN) return { response: fail("origin_not_allowed", 403, id), id };
  if (req.headers.get("x-ops-token") !== cfg.ACE_HUNTER_OPS_API_TOKEN) return { response: fail("unauthorized", 401, id), id };
  if (mutate && req.headers.get("x-csrf-token") !== cfg.ACE_HUNTER_OPS_API_TOKEN) return { response: fail("csrf_failed", 403, id), id };
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > 64 * 1024) return { response: fail("request_too_large", 413, id), id };
  return { id };
}
export function output(value: unknown, id: string, status = 200): NextResponse { return NextResponse.json(value, { status, headers: { "cache-control": "no-store", "x-correlation-id": id } }); }
export function fail(code: string, status: number, id: string): NextResponse { return output({ code, correlation_id: id }, id, status); }
export async function json(req: Request): Promise<Record<string, unknown>> { const value = await req.json(); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_json"); return value as Record<string, unknown>; }
