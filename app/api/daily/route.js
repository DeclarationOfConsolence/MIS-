import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Monday–Saturday window (in IST) for the week containing `ref`, or the
// week N weeks back if `weekOffset` is given. Returns YYYY-MM-DD strings.
function weekRange(weekOffset = 0) {
  const istToday = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const base = new Date(istToday + "T00:00:00Z");
  const dow = base.getUTCDay(); // 0 Sun .. 6 Sat
  const mondayOffset = dow === 0 ? 6 : dow - 1;
  const monday = new Date(base);
  monday.setUTCDate(base.getUTCDate() - mondayOffset - weekOffset * 7);
  const fmt = (x) => x.toISOString().slice(0, 10);
  const dates = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    return fmt(d);
  });
  return { from: dates[0], to: dates[5], dates };
}

// All dates from `from` to `to` inclusive, excluding Sundays (daily is Mon–Sat).
function daysInRange(from, to) {
  const out = [];
  const end = new Date(to + "T00:00:00Z");
  let d = new Date(from + "T00:00:00Z");
  while (d <= end) {
    if (d.getUTCDay() !== 0) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export async function GET(req) {
  const session = cookies().get(SESSION_COOKIE);
  if (!session || !verifySession(session.value)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const sb = getSupabase();
  if (!sb) return NextResponse.json({ error: "NO_SUPABASE" }, { status: 400 });

  const sp = new URL(req.url).searchParams;
  const qFrom = sp.get("from");
  const qTo = sp.get("to");
  let from, to, dates;
  if (qFrom && qTo) {
    // Calendar range selected → show that exact window (Mon–Sat days within it).
    from = qFrom;
    to = qTo;
    dates = daysInRange(from, to);
  } else {
    const weekOffset = Math.max(0, parseInt(sp.get("week") || "0", 10));
    ({ from, to, dates } = weekRange(weekOffset));
  }

  const { data, error } = await sb.rpc("mis_daily_scorecard", { p_from: from, p_to: to });
  if (error) {
    const missing = /mis_daily_scorecard|mis_daily_completions/.test(error.message);
    return NextResponse.json(
      {
        error: missing ? "NO_FUNCTION" : "DB_ERROR",
        message: missing
          ? "Daily tracker not installed yet. Run supabase/daily.sql in Supabase, then sync."
          : error.message,
      },
      { status: missing ? 400 : 500 }
    );
  }

  const { data: meta } = await sb.from("mis_meta").select("value").eq("key", "daily_last_synced").maybeSingle();

  return NextResponse.json({
    from,
    to,
    weekDates: dates, // the 6 Mon–Sat days of this window
    target: 6,
    rows: data || [], // [{ person, task_gid, task, board, done, dates: [...] }]
    lastSynced: (meta && meta.value) || null,
  });
}
