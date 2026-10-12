import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// All dates in IST, to match the sync.
function istToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---- date key helpers ----
function addDaysKey(key, n) {
  const d = new Date(key + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayKeyOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const dow = d.getUTCDay(); // 0 Sun .. 6 Sat
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}
function monthKeyOf(dateStr) {
  return dateStr.slice(0, 7);
}
function lastDayOfMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // day 0 of next month
}
function addMonthsKey(ym, n) {
  let [y, m] = ym.split("-").map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((((idx % 12) + 12) % 12) + 1).padStart(2, "0")}`;
}
// Fortnight: 2-week blocks anchored to a fixed Monday (1970-01-05), so boundaries are stable.
const EPOCH_MON = Date.UTC(1970, 0, 5);
function fortnightStartOf(dateStr) {
  const mon = mondayKeyOf(dateStr);
  const weeks = Math.round((new Date(mon + "T00:00:00Z").getTime() - EPOCH_MON) / (7 * 86400000));
  return addDaysKey(mon, -7 * (((weeks % 2) + 2) % 2));
}
// Bi-month: calendar-aligned 2-month blocks (Jan–Feb, Mar–Apr, …); key = the odd start month.
function bimonthStartOf(dateStr) {
  let [y, m] = dateStr.slice(0, 7).split("-").map(Number);
  if (m % 2 === 0) m -= 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}
function quarterKeyOf(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

// ---- labels ----
function weekLabel(monKey) {
  const d = new Date(monKey + "T00:00:00Z");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
function monthLabel(ym) {
  const [y, m] = ym.split("-");
  return `${MONTHS[+m - 1]} '${y.slice(2)}`;
}
function bimonthLabel(ym) {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]}–${MONTHS[m]} '${String(y).slice(2)}`;
}

// ---- period generators: each returns [{ key, label, start, end }] oldest→newest ----
function lastWeeks(n) {
  const out = [];
  let mon = mondayKeyOf(istToday());
  for (let i = 0; i < n; i++) {
    out.unshift({ key: mon, label: weekLabel(mon), start: mon, end: addDaysKey(mon, 6) });
    mon = addDaysKey(mon, -7);
  }
  return out;
}
function lastBiweeks(n) {
  const out = [];
  let fs = fortnightStartOf(istToday());
  for (let i = 0; i < n; i++) {
    out.unshift({ key: fs, label: weekLabel(fs), start: fs, end: addDaysKey(fs, 13) });
    fs = addDaysKey(fs, -14);
  }
  return out;
}
function lastMonths(n) {
  const out = [];
  let ym = istToday().slice(0, 7);
  for (let i = 0; i < n; i++) {
    out.unshift({ key: ym, label: monthLabel(ym), start: `${ym}-01`, end: lastDayOfMonth(ym) });
    ym = addMonthsKey(ym, -1);
  }
  return out;
}
function lastBimonths(n) {
  const out = [];
  let bs = bimonthStartOf(istToday());
  for (let i = 0; i < n; i++) {
    out.unshift({ key: bs, label: bimonthLabel(bs), start: `${bs}-01`, end: lastDayOfMonth(addMonthsKey(bs, 1)) });
    bs = addMonthsKey(bs, -2);
  }
  return out;
}
function lastQuarters(n) {
  const out = [];
  const t = istToday();
  let y = +t.slice(0, 4);
  let q = Math.floor((+t.slice(5, 7) - 1) / 3) + 1;
  for (let i = 0; i < n; i++) {
    const sm = (q - 1) * 3 + 1;
    out.unshift({
      key: `${y}-Q${q}`,
      label: `Q${q} '${String(y).slice(2)}`,
      start: `${y}-${String(sm).padStart(2, "0")}-01`,
      end: lastDayOfMonth(`${y}-${String(sm + 2).padStart(2, "0")}`),
    });
    q--;
    if (q === 0) {
      q = 4;
      y--;
    }
  }
  return out;
}

// Per-cadence config: how to bucket a due date, and how many periods to show.
const KEYER = {
  weekly: mondayKeyOf,
  biweekly: fortnightStartOf,
  monthly: monthKeyOf,
  bimonthly: bimonthStartOf,
  quarterly: quarterKeyOf,
};
const PERIODS = {
  weekly: () => lastWeeks(6),
  biweekly: () => lastBiweeks(6),
  monthly: () => lastMonths(6),
  bimonthly: () => lastBimonths(6),
  quarterly: () => lastQuarters(4), // last 4 quarters (one year)
};
const KINDS = ["weekly", "biweekly", "monthly", "bimonthly", "quarterly"];

// Periods of a cadence that overlap [from, to] (oldest→newest), mirroring the
// {key,label,start,end} shape of the lastX() generators. Capped at 60.
function periodsInRange(kind, from, to) {
  const out = [];
  if (kind === "weekly" || kind === "biweekly") {
    const step = kind === "weekly" ? 7 : 14;
    let s = kind === "weekly" ? mondayKeyOf(from) : fortnightStartOf(from);
    while (s <= to) {
      out.push({ key: s, label: weekLabel(s), start: s, end: addDaysKey(s, step - 1) });
      s = addDaysKey(s, step);
    }
  } else if (kind === "monthly") {
    let ym = monthKeyOf(from);
    const endYm = monthKeyOf(to);
    while (ym <= endYm) {
      out.push({ key: ym, label: monthLabel(ym), start: `${ym}-01`, end: lastDayOfMonth(ym) });
      ym = addMonthsKey(ym, 1);
    }
  } else if (kind === "bimonthly") {
    let bs = bimonthStartOf(from);
    const endBs = bimonthStartOf(to);
    while (bs <= endBs) {
      out.push({ key: bs, label: bimonthLabel(bs), start: `${bs}-01`, end: lastDayOfMonth(addMonthsKey(bs, 1)) });
      bs = addMonthsKey(bs, 2);
    }
  } else if (kind === "quarterly") {
    let [y, mo] = from.split("-").map(Number);
    let q = Math.floor((mo - 1) / 3) + 1;
    const [ty, tmo] = to.split("-").map(Number);
    const tq = Math.floor((tmo - 1) / 3) + 1;
    while (y < ty || (y === ty && q <= tq)) {
      const sm = (q - 1) * 3 + 1;
      out.push({
        key: `${y}-Q${q}`,
        label: `Q${q} '${String(y).slice(2)}`,
        start: `${y}-${String(sm).padStart(2, "0")}-01`,
        end: lastDayOfMonth(`${y}-${String(sm + 2).padStart(2, "0")}`),
      });
      q++;
      if (q > 4) { q = 1; y++; }
    }
  }
  return out.length > 60 ? out.slice(-60) : out;
}

// Bucket a task's cycles into the period columns → ['on_time'|'missed'|'none', …].
function bucketCells(kind, cycles, periodKeys) {
  const keyer = KEYER[kind];
  // Worst status dominates a period: missed > late > on_time. 'late' is kept
  // distinct — it still counts as COMPLETED, just not on time.
  const sev = (s) => (s === "missed" ? 2 : s === "late" ? 1 : 0);
  const byP = new Map();
  for (const c of cycles || []) {
    if (!c.due) continue;
    const k = keyer(c.due);
    const prev = byP.get(k);
    if (prev === undefined || sev(c.status) > sev(prev)) byP.set(k, c.status);
  }
  return periodKeys.map((k) => (byP.has(k) ? byP.get(k) : "none"));
}

async function buildKind(sb, kind, rangeFrom, rangeTo) {
  const periods = rangeFrom && rangeTo ? periodsInRange(kind, rangeFrom, rangeTo) : PERIODS[kind]();
  if (!periods.length) return { periods: [], rows: [] };
  const keys = periods.map((p) => p.key);
  const from = periods[0].start;
  const to = periods[periods.length - 1].end;

  const { data, error } = await sb.rpc("mis_recurring_scorecard", { p_kind: kind, p_from: from, p_to: to });
  if (error) return { error };

  const rows = (data || []).map((r) => {
    const cells = bucketCells(kind, r.cycles, keys);
    return {
      person: r.person,
      task: r.task,
      task_gid: r.task_gid,
      board: r.board,
      current_due: r.current_due,
      has_due: r.has_due,
      cells,
      done: cells.filter((c) => c === "on_time" || c === "late").length,
    };
  });
  return { periods: periods.map((p) => p.label), rows };
}

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
