import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../lib/web/supabase-server";
export async function GET(request: Request) { const code = new URL(request.url).searchParams.get("code"); if (code) await (await createSupabaseServerClient()).auth.exchangeCodeForSession(code); return NextResponse.redirect(new URL("/", request.url)); }
