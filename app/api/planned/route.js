import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Planned vs Actual: one-time tasks by PLANNED END DATE vs ACTUAL END DATE.
// No from/to params = all time. The Planned End Date is frozen at sync time, so
// there is no Fixed/Dynamic mode any more — one straightforward view.
export async function GET(req) {
  const session = cookies().get(SESSION_COOKIE);
  if (!session || !verifySession(session.value)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const sb = getSupabase();
  if (!sb) return NextResponse.json({ error: "NO_SUPABASE" }, { status: 400 });

  const sp = new URL(req.url).searchParams;
  const { data, error } = await sb.rpc("mis_planned_actual", {
    p_from: sp.get("from") || null,
    p_to: sp.get("to") || null,
  });
  if (error) {
    const missing = /mis_planned_actual/.test(error.message);
    return NextResponse.json(
      {
        error: missing ? "NO_FUNCTION" : "DB_ERROR",
        message: missing
          ? "Planned-vs-Actual function not installed. Run the SQL in Supabase, then reload."
          : error.message,
      },
      { status: missing ? 400 : 500 }
    );
  }
  return NextResponse.json({ rows: data || [] });
}
