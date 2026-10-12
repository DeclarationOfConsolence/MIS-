import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// TEST endpoint: Arjun's one-time tasks scored by PLANNED vs ACTUAL end date
// (custom fields), filtered by Planned End Date in [from, to].

function daysBetween(a, b) {
  return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);
}
// Color: exact or early = green; 1–6 days late = yellow; 7+ days late = red;
// no actual end date yet = pending.
function colorOf(planned, actual) {
  if (!actual || !planned) return "pending";
  const d = daysBetween(planned, actual);
  if (d <= 0) return "green";
  if (d <= 6) return "yellow";
  return "red";
}

export async function GET(req) {
  const session = cookies().get(SESSION_COOKIE);
  if (!session || !verifySession(session.value)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const sb = getSupabase();
  if (!sb) return NextResponse.json({ error: "NO_SUPABASE" }, { status: 400 });

  const sp = new URL(req.url).searchParams;
  const from = sp.get("from");
  const to = sp.get("to");

  let q = sb
    .from("mis_tasks")
    .select("gid,name,planned_end_date,actual_end_date,completed,due_on")
    .eq("is_one_time", true)
    .ilike("assignee", "arjun%")
    .not("planned_end_date", "is", null);
  if (from) q = q.gte("planned_end_date", from);
  if (to) q = q.lte("planned_end_date", to);
  q = q.order("planned_end_date", { ascending: true });

  const { data, error } = await q;
  if (error) {
    const missing = /planned_end_date/.test(error.message);
    return NextResponse.json(
      {
        error: missing ? "NO_COLUMN" : "DB_ERROR",
        message: missing
          ? "Planned/Actual columns not found. Run the ALTER TABLE SQL, then sync."
          : error.message,
      },
      { status: missing ? 400 : 500 }
    );
  }

  const rows = (data || []).map((t) => ({ ...t, color: colorOf(t.planned_end_date, t.actual_end_date) }));
  const planned = rows.length;
  const done = rows.filter((r) => r.actual_end_date).length; // "done" = has an Actual End Date
  const score = planned ? Math.round((100 * done) / planned) - 100 : null;

  return NextResponse.json({ rows, planned, done, score, from: from || null, to: to || null });
}
