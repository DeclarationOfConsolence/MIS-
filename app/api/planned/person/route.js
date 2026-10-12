import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Planned vs Actual, per person, by PLANNED END DATE (+ ACTUAL END DATE for timeliness).
// No ?assignee → returns the list of people who have one-time tasks with a Planned End Date.
// With ?assignee=NAME → returns that person's tasks (Planned End in [from,to]) + a score.

function daysBetween(a, b) {
  return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);
}
// exact/early = green · 1–6 days late = yellow · 7+ days late = red · no actual = pending.
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
  const assignee = sp.get("assignee");

  // ---- Person list (no assignee) ----
  if (!assignee) {
    const { data, error } = await sb
      .from("mis_tasks")
      .select("assignee")
      .eq("is_one_time", true)
      .not("planned_end_date", "is", null);
    if (error) {
      const missing = /planned_end_date/.test(error.message);
      return NextResponse.json(
        {
          error: missing ? "NO_COLUMN" : "DB_ERROR",
          message: missing ? "Planned/Actual columns not found. Run the ALTER TABLE SQL, then sync." : error.message,
        },
        { status: missing ? 400 : 500 }
      );
    }
    const people = [...new Set((data || []).map((r) => r.assignee).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return NextResponse.json({ people });
  }

  // ---- One person's detail ----
  const from = sp.get("from");
  const to = sp.get("to");
  let q = sb
    .from("mis_tasks")
    .select("gid,name,planned_end_date,actual_end_date,completed,due_on")
    .eq("is_one_time", true)
    .eq("assignee", assignee)
    .not("planned_end_date", "is", null);
  if (from) q = q.gte("planned_end_date", from);
  if (to) q = q.lte("planned_end_date", to);
  q = q.order("planned_end_date", { ascending: true });

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: "DB_ERROR", message: error.message }, { status: 500 });

  const rows = (data || []).map((t) => ({ ...t, color: colorOf(t.planned_end_date, t.actual_end_date) }));
  const planned = rows.length;
  const done = rows.filter((r) => r.actual_end_date).length; // "done" = has an Actual End Date
  const score = planned ? Math.round((100 * done) / planned) - 100 : null;

  return NextResponse.json({ assignee, rows, planned, done, score, from: from || null, to: to || null });
}
