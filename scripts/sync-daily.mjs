// Sync DAILY to-do completions from Asana into Supabase.
//
//   npm run sync:daily              (loads .env.local, writes to Supabase)
//   npm run sync:daily -- --dry-run (reads Asana only, prints scorecard, writes NOTHING)
//
// Reads each person's "To do" board -> DAILY section -> every task's story
// log, and records every "marked complete" event (who + when, IST day).

import { createClient } from "@supabase/supabase-js";
import { syncDailyCompletions } from "../lib/daily.js";

const dryRun = process.argv.includes("--dry-run");

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const token = process.env.ASANA_TOKEN;

if (!token || token.startsWith("paste")) {
  console.error("✗ Missing ASANA_TOKEN");
  process.exit(1);
}
if (!dryRun && (!url || !key)) {
  console.error("✗ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (or pass --dry-run)");
  process.exit(1);
}

const sb = dryRun ? null : createClient(url, key, { auth: { persistSession: false } });

const t0 = Date.now();
console.log(`→ Daily completion sync${dryRun ? " (DRY RUN — no writes)" : ""}…`);

const { rows, roster, stats } = await syncDailyCompletions(sb, token, process.env.ASANA_WORKSPACE_GID || "", { dryRun });

// ---- Print a Mon–Sat scorecard for the CURRENT week (preview) ----
function istToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
const base = new Date(istToday() + "T00:00:00Z");
const dow = base.getUTCDay(); // 0 Sun .. 6 Sat
const mondayOffset = dow === 0 ? 6 : dow - 1;
const monday = new Date(base);
monday.setUTCDate(base.getUTCDate() - mondayOffset);
const fmt = (x) => x.toISOString().slice(0, 10);
const weekDates = Array.from({ length: 6 }, (_, i) => {
  const d = new Date(monday);
  d.setUTCDate(monday.getUTCDate() + i);
  return fmt(d);
});
const from = weekDates[0];
const to = weekDates[5];

// Distinct ticked weekdays (Mon–Sat) per task within this week's window.
const ticksByTask = new Map(); // task_gid -> Set(dates)
for (const r of rows) {
  if (r.completed_date < from || r.completed_date > to) continue;
  const dow = new Date(r.completed_date + "T00:00:00Z").getUTCDay();
  if (dow === 0) continue; // exclude Sundays
  if (!ticksByTask.has(r.task_gid)) ticksByTask.set(r.task_gid, new Set());
  ticksByTask.get(r.task_gid).add(r.completed_date);
}

console.log(`\n── This-week scorecard (Mon ${from} → Sat ${to}, IST) ──`);
console.log(
  `   Boards in scope: ${stats.boards} | daily tasks: ${stats.dailyTasks} | assigned (shown): ${stats.roster} | unassigned (skipped): ${stats.unassigned} | excluded samples: ${stats.excludedSamples}`
);
if (!roster || roster.length === 0) {
  console.log("   (no assigned daily tasks found in any To-Do board's DAILY section)");
} else {
  // Driven by the roster, so never-ticked tasks show as 0/6 — same as the app.
  const lines = roster
    .map((t) => ({ person: t.assignee, task: t.task_name, n: (ticksByTask.get(t.task_gid) || new Set()).size }))
    .sort((a, b) => a.person.localeCompare(b.person) || b.n - a.n || a.task.localeCompare(b.task));
  for (const l of lines.slice(0, 40)) {
    const bar = "✓".repeat(l.n) + "·".repeat(Math.max(0, 6 - l.n));
    console.log(`   ${l.n}/6 [${bar}]  ${l.person} — ${l.task}`);
  }
  if (lines.length > 40) console.log(`   …and ${lines.length - 40} more`);
}

console.log(`\n${dryRun ? "✅ Dry run complete" : "✅ Sync complete"} in ${((Date.now() - t0) / 1000).toFixed(0)}s.`);
