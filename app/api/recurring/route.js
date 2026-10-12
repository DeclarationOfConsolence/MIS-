import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { buildKind, KINDS } from "@/lib/recurringPeriods";

export const dynamic = "force-dynamic";

export async function GET(req) {
  const session = cookies().get(SESSION_COOKIE);
  if (!session || !verifySession(session.value)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const sb = getSupabase();
  if (!sb) return NextResponse.json({ error: "NO_SUPABASE" }, { status: 400 });

  const sp = new URL(req.url).searchParams;
  const rangeFrom = sp.get("from"); // Calendar range → show periods overlapping it
  const rangeTo = sp.get("to");
  const built = await Promise.all(KINDS.map((k) => buildKind(sb, k, rangeFrom, rangeTo)));
  const failed = built.find((b) => b.error);
  if (failed) {
    const missing = /mis_recurring/.test(failed.error.message || "");
    return NextResponse.json(
      {
        error: missing ? "NO_FUNCTION" : "DB_ERROR",
        message: missing
          ? "Recurring tracker not installed yet. Run supabase/recurring.sql, then sync."
          : failed.error.message,
      },
      { status: missing ? 400 : 500 }
    );
  }

  const out = {};
  KINDS.forEach((k, i) => {
    out[k] = built[i];
  });

  const { data: meta } = await sb.from("mis_meta").select("value").eq("key", "recurring_last_synced").maybeSingle();

  return NextResponse.json({ ...out, lastSynced: (meta && meta.value) || null });
}
