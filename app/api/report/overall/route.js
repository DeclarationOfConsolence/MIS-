import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { computeTodoSummary } from "@/lib/todoSummary";

export const dynamic = "force-dynamic";

// Overall Summary: one row per person combining One-Time, Meeting, and To-Do.
// Meeting tasks are a SUBSET of One-Time (not separate), so the combined Total
// is One-Time + To-Do only — Meeting is shown as its own column for visibility,
// not added again. Completed/Pending/Overdue/No-date come ONLY from One-Time's
// status buckets (mutually exclusive, sum to One-Time's total, never the grand
// Total). To-Do is deliberately excluded from these 4 buckets: a recurring
// task's "done" count is a count of TICKS (one task ticked 6 times this week =
// 6), not a task-level completion state — mixing that into a task-count bucket
// would make Completed exceed Total. To-Do only ever contributes to Total/To-Do.
export async function GET(req) {
  const session = cookies().get(SESSION_COOKIE);
  if (!session || !verifySession(session.value)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const sb = getSupabase();
  if (!sb) return NextResponse.json({ error: "NO_SUPABASE" }, { status: 400 });

  const sp = new URL(req.url).searchParams;
  const from = sp.get("from") || null;
  const to = sp.get("to") || null;

  const [oneTimeRes, meetingRes, todoSummary] = await Promise.all([
    sb.rpc("mis_task_status_summary", { p_from: from, p_to: to, p_meeting_only: false }),
    sb.rpc("mis_task_status_summary", { p_from: from, p_to: to, p_meeting_only: true }),
    computeTodoSummary(sb, from, to),
  ]);

  if (oneTimeRes.error || meetingRes.error) {
    const err = oneTimeRes.error || meetingRes.error;
    const missing = /mis_task_status_summary/.test(err.message || "");
    return NextResponse.json(
      {
        error: missing ? "NO_FUNCTION" : "DB_ERROR",
        message: missing ? "Run the mis_task_status_summary SQL in Supabase, then reload." : err.message,
      },
      { status: missing ? 400 : 500 }
    );
  }
  if (todoSummary.error) {
    return NextResponse.json(
      { error: todoSummary.error.missing ? "NO_FUNCTION" : "DB_ERROR", message: todoSummary.error.message },
      { status: todoSummary.error.missing ? 400 : 500 }
    );
  }

  const oneTimeByPerson = new Map((oneTimeRes.data || []).map((r) => [r.assignee, r]));
  const meetingByPerson = new Map((meetingRes.data || []).map((r) => [r.assignee, r]));
  const names = new Set([...oneTimeByPerson.keys(), ...meetingByPerson.keys(), ...todoSummary.people.keys()]);

  const rows = [...names]
    .map((name) => {
      const ot = oneTimeByPerson.get(name) || { total: 0, completed: 0, overdue: 0, pending: 0, no_date: 0 };
      const mt = meetingByPerson.get(name) || { total: 0 };
      const td = todoSummary.people.get(name) || { taskCount: 0, doneTicks: 0 };
      return {
        assignee: name,
        total: ot.total + td.taskCount,
        oneTime: ot.total,
        meeting: mt.total,
        todo: td.taskCount,
        completed: ot.completed,
        overdue: ot.overdue,
        pending: ot.pending,
        noDate: ot.no_date,
      };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => a.assignee.localeCompare(b.assignee));

  return NextResponse.json({ from: from || todoSummary.from, to: to || todoSummary.to, rows });
}
