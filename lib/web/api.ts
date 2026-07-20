import { NextResponse } from "next/server";

export async function readTarget(request: Request): Promise<string | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > 16_384) return null;
  try {
    const value = await request.json() as { target?: unknown };
    if (typeof value.target !== "string") return null;
    const target = value.target.trim();
    return target.length > 0 && target.length <= 512 ? target : null;
  } catch { return null; }
}

export function failure(code: string, status = 500) {
  return NextResponse.json({ code }, { status });
}

export function output(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
