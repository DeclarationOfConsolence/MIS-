// READ-ONLY inspection of WEEKLY and MONTHLY to-do sections in Asana.
// Writes NOTHING (no Supabase, no Asana changes). Helps design the
// weekly/monthly tracker by revealing section names, task counts, and how
// recurring tasks behave (same task with a shifting due date, vs a fresh
// copy each cycle).
//
//   node --env-file=.env.local scripts/inspect-weekly-monthly.mjs

const BASE = "https://app.asana.com/api/1.0";
const token = process.env.ASANA_TOKEN;
const pinnedWs = process.env.ASANA_WORKSPACE_GID || "";
if (!token) {
  console.error("✗ Missing ASANA_TOKEN");
  process.exit(1);
}

const BOARD_RE = /to.?do/i;
const EXCLUDE_RE = /sample|test|template/i;
const WEEKLY_RE = /weekly/i;
const MONTHLY_RE = /monthly/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function aget(path, params = {}, attempt = 0) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 5) {
    const ra = Number(res.headers.get("Retry-After"));
    await sleep(ra ? ra * 1000 : Math.min(1000 * 2 ** attempt, 15000));
    return aget(path, params, attempt + 1);
  }
  if (!res.ok) throw new Error(`Asana ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

async function agetAll(path, params = {}) {
  const out = [];
  let offset;
  do {
    const p = { ...params, limit: 100 };
    if (offset) p.offset = offset;
    const d = await aget(path, p);
    out.push(...(d.data || []));
    offset = d.next_page ? d.next_page.offset : undefined;
  } while (offset);
  return out;
}

const ws = pinnedWs || (await aget("/workspaces", { limit: 100 })).data?.[0]?.gid;
console.log("Workspace:", ws);

const projects = await agetAll("/projects", { workspace: ws, opt_fields: "name,archived" });
const boards = projects.filter((p) => !p.archived && BOARD_RE.test(p.name) && !EXCLUDE_RE.test(p.name));
console.log(`To-do boards in scope: ${boards.length}`);

let weeklySecCount = 0;
let monthlySecCount = 0;
const weeklyNames = new Set();
const monthlyNames = new Set();
const boardsWithWeekly = [];
const boardsWithMonthly = [];

for (const b of boards) {
  let sections = [];
  try {
    sections = (await aget(`/projects/${b.gid}/sections`, { opt_fields: "name" })).data || [];
  } catch {
    continue;
  }
  const w = sections.find((s) => WEEKLY_RE.test(s.name));
  const m = sections.find((s) => MONTHLY_RE.test(s.name));
  if (w) {
    weeklySecCount++;
    weeklyNames.add(w.name.trim());
    boardsWithWeekly.push({ b, sec: w });
  }
  if (m) {
    monthlySecCount++;
    monthlyNames.add(m.name.trim());
    boardsWithMonthly.push({ b, sec: m });
  }
}

console.log(`\nBoards with a WEEKLY section:  ${weeklySecCount}`);
console.log(`   distinct WEEKLY names:  ${[...weeklyNames].map((n) => `"${n}"`).join(" | ") || "(none)"}`);
console.log(`Boards with a MONTHLY section: ${monthlySecCount}`);
console.log(`   distinct MONTHLY names: ${[...monthlyNames].map((n) => `"${n}"`).join(" | ") || "(none)"}`);

const TASK_FIELDS = "name,assignee.name,due_on,due_at,completed,completed_at";

async function dumpTasks(label, list, n) {
  console.log(`\n===== ${label}: tasks from up to ${n} boards =====`);
  let totalTasks = 0;
  for (const { b, sec } of list.slice(0, n)) {
    let tasks = [];
    try {
      tasks = await agetAll(`/sections/${sec.gid}/tasks`, { opt_fields: TASK_FIELDS });
    } catch {
      continue;
    }
    totalTasks += tasks.length;
    console.log(`\n--- Board "${b.name}"  ·  Section "${sec.name}"  ·  ${tasks.length} tasks ---`);
    for (const t of tasks) {
      const comp = t.completed_at ? t.completed_at.slice(0, 10) : "—";
      console.log(
        `   [${t.completed ? "DONE" : "open"}] due=${t.due_on || "—"}  completed=${comp}  ` +
          `asg=${(t.assignee && t.assignee.name) || "—"}   ${t.name}`
      );
    }
  }
  return totalTasks;
}

await dumpTasks("WEEKLY", boardsWithWeekly, 3);
await dumpTasks("MONTHLY", boardsWithMonthly, 3);

// Story-log sample → detect recurrence behavior.
//  - many marked_complete on ONE task  => same task, due date shifts (same GID)
//  - due_date_changed events present    => due date moves over time
//  - each task has <=1 marked_complete  => likely a NEW copy per cycle (new GID)
async function sampleStories(label, list, max) {
  console.log(`\n===== ${label}: story-log sample (recurrence behaviour) =====`);
  let sampled = 0;
  for (const { b, sec } of list) {
    if (sampled >= max) break;
    let tasks = [];
    try {
      tasks = await agetAll(`/sections/${sec.gid}/tasks`, { opt_fields: "name" });
    } catch {
      continue;
    }
    for (const t of tasks) {
      if (sampled >= max) break;
      let stories = [];
      try {
        stories = await agetAll(`/tasks/${t.gid}/stories`, { opt_fields: "resource_subtype,created_at,text" });
      } catch {
        continue;
      }
      const sub = (x) => stories.filter((s) => s.resource_subtype === x);
      console.log(`\n   Task "${t.name}"  (board "${b.name}")`);
      console.log(
        `     marked_complete=${sub("marked_complete").length}  ` +
          `marked_incomplete=${sub("marked_incomplete").length}  ` +
          `due_date_changed=${sub("due_date_changed").length}`
      );
      const evts = stories
        .filter((s) => ["marked_complete", "marked_incomplete", "due_date_changed"].includes(s.resource_subtype))
        .sort((a, b2) => (a.created_at || "").localeCompare(b2.created_at || ""));
      for (const s of evts.slice(0, 12)) {
        console.log(`       ${(s.created_at || "").slice(0, 10)}  ${s.resource_subtype}  ${(s.text || "").slice(0, 70)}`);
      }
      sampled++;
    }
  }
}

await sampleStories("WEEKLY", boardsWithWeekly, 4);
await sampleStories("MONTHLY", boardsWithMonthly, 4);

console.log("\n✅ Inspection done (read-only — nothing was written).");
