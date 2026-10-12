// Shared To-Do aggregation — used by /api/report/todo (Total + Score) and
// /api/report/overall (Total + Completed, rolled into the combined summary).
// Score methodology matches the To-Do Tasks tab's per-person scorecard exactly:
// each cadence (Daily, Weekly, Biweekly, Monthly, Bimonthly, Quarterly) scores
// independently, then all available percentages are averaged together equally.
import { buildKind, KINDS, istToday } from "./recurringPeriods";

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

/**
 * Returns a Map<person, { taskCount, doneTicks, sectionPcts }> or an object
 * with `.error` set if an underlying RPC failed (NO_FUNCTION/DB_ERROR shaped).
 */
export async function computeTodoSummary(sb, rangeFrom, rangeTo) {
  const people = new Map();
  const ensure = (person) => {
    if (!people.has(person)) people.set(person, { taskCount: 0, doneTicks: 0, sectionPcts: [] });
    return people.get(person);
  };

  // ---- Daily ----
  let dailyFrom = rangeFrom, dailyTo = rangeTo;
  if (!dailyFrom || !dailyTo) {
    // Default to the current Mon–Sat week, same as the To-Do Tasks tab.
    const today = istToday();
    const d = new Date(today + "T00:00:00Z");
    const dow = d.getUTCDay();
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
    const saturday = new Date(monday);
    saturday.setUTCDate(monday.getUTCDate() + 5);
    dailyFrom = monday.toISOString().slice(0, 10);
    dailyTo = saturday.toISOString().slice(0, 10);
  }
  const { data: dailyRows, error: dailyErr } = await sb.rpc("mis_daily_scorecard", { p_from: dailyFrom, p_to: dailyTo });
  if (dailyErr) {
    const missing = /mis_daily_scorecard|mis_daily_completions/.test(dailyErr.message);
    return { error: { missing, message: dailyErr.message } };
  }
  const today = istToday();
  const weekDates = daysInRange(dailyFrom, dailyTo);
  const endedDates = weekDates.filter((d) => d <= today);
  const dailyByPerson = new Map();
  for (const r of dailyRows || []) {
    if (!dailyByPerson.has(r.person)) dailyByPerson.set(r.person, []);
    dailyByPerson.get(r.person).push(r);
  }
  for (const [person, rows] of dailyByPerson) {
    const p = ensure(person);
    p.taskCount += rows.length;
    let done = 0;
    for (const t of rows) {
      const set = new Set(t.dates || []);
      for (const d of endedDates) if (set.has(d)) done++;
    }
    p.doneTicks += done;
    const total = rows.length * endedDates.length;
    if (total > 0) p.sectionPcts.push(Math.round((100 * done) / total));
  }

  // ---- Recurring (weekly..quarterly) ----
  for (const kind of KINDS) {
    const built = await buildKind(sb, kind, rangeFrom, rangeTo);
    if (built.error) {
      const missing = /mis_recurring/.test(built.error.message || "");
      return { error: { missing, message: built.error.message } };
    }
    const endedCount = built.endedCount ?? (built.periods || []).length;
    const byPerson = new Map();
    for (const r of built.rows || []) {
      if (!r.has_due) continue; // no due date set — not a scorable opportunity, and not counted
      if (!byPerson.has(r.person)) byPerson.set(r.person, []);
      byPerson.get(r.person).push(r);
    }
    for (const [person, rows] of byPerson) {
      const p = ensure(person);
      p.taskCount += rows.length;
      let done = 0;
      for (const t of rows) {
        for (const v of (t.cells || []).slice(0, endedCount)) {
          if (v === "on_time" || v === "late") done++;
        }
      }
      p.doneTicks += done;
      const total = rows.length * endedCount;
      if (total > 0) p.sectionPcts.push(Math.round((100 * done) / total));
    }
  }

  return { people, from: dailyFrom, to: dailyTo };
}

export function todoScore(p) {
  if (!p.sectionPcts.length) return null;
  const avg = Math.round(p.sectionPcts.reduce((a, b) => a + b, 0) / p.sectionPcts.length);
  return avg - 100;
}
