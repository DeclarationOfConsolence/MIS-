import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { computeTodoSummary, todoScore } from "@/lib/todoSummary";

export const dynamic = "force-dynamic";

// To-Do report summary: Total (distinct tasks assigned, stable regardless of
// range) + Score per person. Score uses the EXACT SAME method as the To-Do
// Tasks tab's per-person scorecard: each cadence's own % (Daily, Weekly,
// Biweekly, Monthly, Bimonthly, Quarterly) is computed independently, then
// averaged together equally — not one pooled ratio weighted by task volume.
export async function GET(req) {
  const session = cookies().get(SESSION_COOKIE);
  if (!session || !verifySession(session.value)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const sb = getSupabase();
  if (!sb) return NextResponse.json({ error: "NO_SUPABASE" }, { status: 400 });

  const sp = new URL(req.url).searchParams;
  const rangeFrom = sp.get("from") || null;
  const rangeTo = sp.get("to") || null;

  const summary = await computeTodoSummary(sb, rangeFrom, rangeTo);
  if (summary.error) {
    return NextResponse.json(
      { error: summary.error.missing ? "NO_FUNCTION" : "DB_ERROR", message: summary.error.message },
      { status: summary.error.missing ? 400 : 500 }
    );
  }

  const rows = [...summary.people.entries()]
    .filter(([, p]) => p.taskCount > 0)
    .map(([person, p]) => ({ person, total: p.taskCount, score: todoScore(p) }))
    .sort((a, b) => (a.score ?? 1) - (b.score ?? 1));

  return NextResponse.json({ from: rangeFrom || summary.from, to: rangeTo || summary.to, rows });
}
