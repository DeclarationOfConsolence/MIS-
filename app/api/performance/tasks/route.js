import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// All of one person's ONE-TIME tasks (for the Performance drill-down).
export async function GET(req) {
  const session = cookies().get(SESSION_COOKIE);
  if (!session || !verifySession(session.value)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const sb = getSupabase();
  if (!sb) return NextResponse.json({ error: "NO_SUPABASE" }, { status: 400 });

  const sp = new URL(req.url).searchParams;
  const assignee = sp.get("assignee");
  const dFrom = sp.get("from") || null; // calendar: ADDED/CREATED date window
  const dTo = sp.get("to") || null;
  if (!assignee) return NextResponse.json({ error: "NO_ASSIGNEE" }, { status: 400 });

  // Next calendar day, for the created-date upper bound (IST day boundaries).
  const nextDay = (d) => {
    const x = new Date(d + "T00:00:00Z");
    x.setUTCDate(x.getUTCDate() + 1);
    return x.toISOString().slice(0, 10);
  };

  const tasks = [];
  let offset = 0;
  for (;;) {
    let q = sb
      .from("mis_tasks")
      .select("gid,name,due_on,created_at,completed,completed_at,original_due_on,projects,section,sections,one_time_section")
      .eq("assignee", assignee)
      .eq("is_one_time", true)
      .eq("archived", false);
    if (dFrom) q = q.gte("created_at", `${dFrom}T00:00:00+05:30`);
    if (dTo) q = q.lt("created_at", `${nextDay(dTo)}T00:00:00+05:30`);
    q = q.order("due_on", { ascending: true, nullsFirst: false }).range(offset, offset + 999);
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: "DB_ERROR", message: error.message }, { status: 500 });
    tasks.push(...(data || []));
    if (!data || data.length < 1000) break;
    offset += 1000;
  }

  // One-time SUBTASKS for this person — included so the drill-down list matches
  // the (subtask-inclusive) scorecard total. They carry the parent's
  // one_time_section, so the drawer groups them under the same section. Guarded:
  // if the table isn't there yet, just skip (parent list still renders).
  let subQ = sb
    .from("mis_one_time_subtasks")
    .select("gid,name,due_on,created_at,completed,completed_at,original_due_on,one_time_section")
    .eq("assignee", assignee)
    .eq("archived", false);
  if (dFrom) subQ = subQ.gte("created_at", `${dFrom}T00:00:00+05:30`);
  if (dTo) subQ = subQ.lt("created_at", `${nextDay(dTo)}T00:00:00+05:30`);
  const { data: subs } = await subQ.order("due_on", { ascending: true, nullsFirst: false });
  for (const s of subs || []) tasks.push({ ...s, is_subtask: true });

  return NextResponse.json({ assignee, tasks });
}
