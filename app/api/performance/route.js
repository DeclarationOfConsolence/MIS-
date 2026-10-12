import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req) {
  const session = cookies().get(SESSION_COOKIE);
  if (!session || !verifySession(session.value)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const sb = getSupabase();
  if (!sb) return NextResponse.json({ error: "NO_SUPABASE" }, { status: 400 });

  const sp = new URL(req.url).searchParams;
  const { data, error } = await sb.rpc("mis_performance", {
    p_from: sp.get("from") || null,
    p_to: sp.get("to") || null,
  });
  if (error) {
    const missing = /mis_performance|original_due_on/.test(error.message);
    return NextResponse.json(
      {
        error: missing ? "NO_FUNCTION" : "DB_ERROR",
        message: missing
          ? "Performance function not installed. Run the performance SQL in Supabase, then reload."
          : error.message,
      },
      { status: missing ? 400 : 500 }
    );
  }
  return NextResponse.json({ rows: data || [] });
}
