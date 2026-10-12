// Sync WEEKLY + MONTHLY recurring to-do tracking from Asana.
//
//   node --env-file=.env.local scripts/sync-recurring.mjs --dry-run            (read Asana only, print preview)
//   node --env-file=.env.local scripts/sync-recurring.mjs --dry-run --boards=4 (just the first 4 boards — fast)
//
// (DB write path is added once the dry-run preview looks right.)

import { createClient } from "@supabase/supabase-js";
import { syncRecurring } from "../lib/recurring.js";

const dryRun = process.argv.includes("--dry-run");
const boardsArg = process.argv.find((a) => a.startsWith("--boards="));
const maxBoards = boardsArg ? parseInt(boardsArg.split("=")[1], 10) : 0;

const token = process.env.ASANA_TOKEN;
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!token) {
  console.error("✗ Missing ASANA_TOKEN");
  process.exit(1);
}
if (!dryRun && (!url || !key)) {
  console.error("✗ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (or pass --dry-run)");
  process.exit(1);
}
const sb = dryRun ? null : createClient(url, key, { auth: { persistSession: false } });

const t0 = Date.now();
console.log(
  `→ Recurring (weekly/monthly)${dryRun ? " DRY RUN — no writes" : ""}${maxBoards ? `, first ${maxBoards} boards` : ""}…`
);

const { roster, cycles, stats } = await syncRecurring(sb, token, process.env.ASANA_WORKSPACE_GID || "", {
  dryRun,
  maxBoards,
  log: console.log,
});

// ---- Period helpers (IST) ----
function istToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
function mondayKey(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const dow = d.getUTCDay(); // 0 Sun .. 6 Sat
  const off = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - off);
  return d.toISOString().slice(0, 10);
}
function monthKey(dateStr) {
  return dateStr.slice(0, 7);
}
function lastWeeks(n) {
  const keys = [];
  const m = new Date(mondayKey(istToday()) + "T00:00:00Z");
  for (let i = 0; i < n; i++) {
    keys.unshift(m.toISOString().slice(0, 10));
    m.setUTCDate(m.getUTCDate() - 7);
  }
  return keys;
}
function lastMonths(n) {
  const keys = [];
  const t = istToday();
  let y = +t.slice(0, 4);
  let mo = +t.slice(5, 7);
  for (let i = 0; i < n; i++) {
    keys.unshift(`${y}-${String(mo).padStart(2, "0")}`);
    mo--;
    if (mo === 0) {
      mo = 12;
      y--;
    }
  }
  return keys;
}

const cyclesByTask = new Map(); // `${gid}|${kind}` -> [cycle]
for (const c of cycles) {
  const k = `${c.task_gid}|${c.kind}`;
  if (!cyclesByTask.has(k)) cyclesByTask.set(k, []);
  cyclesByTask.get(k).push(c);
}

function gridFor(taskCycles, kind, periodKeys) {
  const keyer = kind === "weekly" ? mondayKey : monthKey;
  const sev = (s) => (s === "on_time" ? 0 : 1); // missed/late dominates the period
  const byPeriod = new Map();
  for (const c of taskCycles || []) {
    const k = keyer(c.due_date);
    const prev = byPeriod.get(k);
    if (prev === undefined || sev(c.status) > sev(prev)) byPeriod.set(k, c.status);
  }
  return periodKeys.map((k) => {
    if (!byPeriod.has(k)) return "·";
    return byPeriod.get(k) === "on_time" ? "✓" : "✗";
  });
}

function previewKind(kind, periodKeys, labelFmt) {
  const rows = roster.filter((r) => r.kind === kind && r.has_due);
  const byPerson = new Map();
  for (const r of rows) {
    if (!byPerson.has(r.assignee)) byPerson.set(r.assignee, []);
    byPerson.get(r.assignee).push(r);
  }
  console.log(`\n══════ ${kind.toUpperCase()} — last ${periodKeys.length} ${kind === "weekly" ? "weeks" : "months"} ══════`);
  console.log(`   columns: ${periodKeys.map(labelFmt).join("  ")}`);
  const people = [...byPerson.keys()].sort((a, b) => a.localeCompare(b));
  let shown = 0;
  for (const p of people) {
    if (shown >= 18) {
      console.log(`   …and more people`);
      break;
    }
    console.log(`\n   ${p}`);
    for (const r of byPerson.get(p)) {
      const grid = gridFor(cyclesByTask.get(`${r.task_gid}|${kind}`), kind, periodKeys);
      const done = grid.filter((g) => g === "✓").length;
      console.log(`     [${grid.join(" ")}]  ${done}/${grid.length}  due=${r.current_due || "—"}  ${r.task_name}`);
      shown++;
      if (shown >= 18) break;
    }
  }
}

console.log(`\n── PREVIEW (Today ${istToday()} IST) ──`);
console.log(
  `   boards ${stats.boards} | task rows ${stats.taskRows} | assigned ${stats.assigned} ` +
    `(weekly ${stats.weekly}, monthly ${stats.monthly}) | unassigned ${stats.unassigned} | no-due ${stats.noDue}`
);

previewKind("weekly", lastWeeks(6), (k) => k.slice(5)); // MM-DD of the Monday
previewKind("monthly", lastMonths(6), (k) => k); // YYYY-MM

console.log(`\n✅ ${dryRun ? "Dry run" : "Done"} in ${((Date.now() - t0) / 1000).toFixed(0)}s.`);
