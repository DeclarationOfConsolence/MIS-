import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { computeTodoSummary } from "@/lib/todoSummary";

export const dynamic = "force-dynamic";

// Small combined KPI box above the Report tab: Total / Completed / Overdue /
// Pending / No date set / Unassigned, across One-Time + To-Do (Meeting is a
// subset of One-Time, so not added again — same rule as the Overall table).
// One-Time excludes the "CRM" and "Recruitment" boards (mis_combined_kpi).
// To-Do has no board-exclusion concept of its own and no overdue/pending/
// unassigned concept (unassigned daily/recurring tasks are skipped at sync
// time already) — it only contributes to Total and No date set.
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

  const [kpiRes, todoSummary, noDateRes] = await Promise.all([
    sb.rpc("mis_combined_kpi", { p_from: from, p_to: to }),
    computeTodoSummary(sb, from, to),
    sb.from("mis_recurring_tasks").select("task_gid", { count: "exact", head: true }).eq("has_due", false),
  ]);

  if (kpiRes.error) {
    const missing = /mis_combined_kpi/.test(kpiRes.error.message || "");
    return NextResponse.json(
      {
        error: missing ? "NO_FUNCTION" : "DB_ERROR",
        message: missing ? "Run the mis_combined_kpi SQL in Supabase, then reload." : kpiRes.error.message,
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

  const k = kpiRes.data || {};
  const todoTotal = [...todoSummary.people.values()].reduce((a, p) => a + p.taskCount, 0);
  const todoNoDate = noDateRes.count || 0;

  return NextResponse.json({
    total: (k.total || 0) + todoTotal,
    completed: k.completed || 0,
    overdue: k.overdue || 0,
    pending: k.pending || 0,
    noDate: (k.no_date || 0) + todoNoDate,
    unassigned: k.unassigned || 0,
  });
}
