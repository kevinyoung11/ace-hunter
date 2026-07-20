import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { readWebConfig } from "./environment";
import { createSupabaseServerClient } from "./supabase-server";

export class WebAuthError extends Error {
  constructor(readonly code: "unauthenticated" | "forbidden") {
    super(code);
  }
}

export function sameUser(left: string, right: string): boolean {
  const leftValue = Buffer.from(left);
  const rightValue = Buffer.from(right);
  return leftValue.length === rightValue.length && timingSafeEqual(leftValue, rightValue);
}

export async function requireOwner(): Promise<void> {
  const client = await createSupabaseServerClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) throw new WebAuthError("unauthenticated");
  if (!sameUser(user.id, readWebConfig().ownerUserId)) throw new WebAuthError("forbidden");
}

export function authErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof WebAuthError)) return null;
  return NextResponse.json({ code: error.code }, { status: error.code === "unauthenticated" ? 401 : 403 });
}
