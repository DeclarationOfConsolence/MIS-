import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const CATEGORIES = ["one_time", "todo", "meeting"];

function requireSession() {
  const session = cookies().get(SESSION_COOKIE);
  return session ? verifySession(session.value) : null;
}

// GET /api/report/targets?week_start=YYYY-MM-DD — every target set for that week.
export async function GET(req) {
  if (!requireSession()) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const sb = getSupabase();
  if (!sb) return NextResponse.json({ error: "NO_SUPABASE" }, { status: 400 });

  const weekStart = new URL(req.url).searchParams.get("week_start");
  if (!weekStart) return NextResponse.json({ error: "MISSING_WEEK", message: "week_start required" }, { status: 400 });

  const { data, error } = await sb
    .from("mis_targets")
    .select("assignee,category,target_score")
    .eq("week_start", weekStart);
  if (error) {
    const missing = /mis_targets/i.test(error.message || "");
    return NextResponse.json(
      { error: missing ? "NO_TABLE" : "DB_ERROR", message: missing ? "Run supabase/targets.sql in Supabase, then reload." : error.message },
      { status: missing ? 400 : 500 }
    );
  }
  return NextResponse.json({ week_start: weekStart, targets: data || [] });
}

// PUT /api/report/targets — body { assignee, category, week_start, target_score }
// target_score: null clears it. Each week is independent — no carry-forward.
export async function PUT(req) {
  if (!requireSession()) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const sb = getSupabase();
  if (!sb) return NextResponse.json({ error: "NO_SUPABASE" }, { status: 400 });

  const body = await req.json().catch(() => null);
  const { assignee, category, week_start, target_score } = body || {};
  if (!assignee || !CATEGORIES.includes(category) || !week_start) {
    return NextResponse.json({ error: "BAD_INPUT", message: "assignee, category, week_start required" }, { status: 400 });
  }
  const score = target_score === null || target_score === undefined || target_score === "" ? null : Number(target_score);
  if (score != null && (!Number.isFinite(score) || score < -100 || score > 0)) {
    return NextResponse.json({ error: "BAD_INPUT", message: "target_score must be between -100 and 0" }, { status: 400 });
  }

  const { error } = await sb
    .from("mis_targets")
    .upsert(
      { assignee, category, week_start, target_score: score, updated_at: new Date().toISOString() },
      { onConflict: "assignee,category,week_start" }
    );
  if (error) {
    const missing = /mis_targets/i.test(error.message || "");
    return NextResponse.json(
      { error: missing ? "NO_TABLE" : "DB_ERROR", message: missing ? "Run supabase/targets.sql in Supabase, then reload." : error.message },
      { status: missing ? 400 : 500 }
    );
  }
  return NextResponse.json({ ok: true });
}
