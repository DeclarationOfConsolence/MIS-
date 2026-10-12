// ============================================================
// Weekly / Monthly recurring to-do tracking.
//
// Like lib/daily.js, but for recurring tasks that carry a DUE DATE.
// In this Asana workspace a recurring task keeps the SAME gid: when ticked,
// Asana marks it complete, reopens it, and pushes the due date forward
// (+7 days weekly / +1 month monthly). Its permanent story log therefore
// holds EVERY completion and EVERY due-date change — enough to rebuild, for
// each past cycle, whether it was done ON TIME or MISSED.
//
//   on time = ticked on or before the due date in effect at that moment
//   missed  = a due date passed without an on-time tick (late counts as missed)
//
// Tasks are grouped by ASSIGNEE (unassigned skipped). Tasks with no due date
// can't be scored, so they're flagged "no_due". Self-contained; does not touch
// lib/asana.js or lib/daily.js.
// ============================================================

const BASE = "https://app.asana.com/api/1.0";

const BOARD_RE = /to.?do/i;
const EXCLUDE_RE = /sample|test|template/i;

// A recurring task only counts for the person whose OWN board it's in — never a
// shared/team board (e.g. "Inventory's TO-DO Board"). Board belongs to a person
// if its name contains the person's name (override for odd cases).
const OWN_BOARD_OVERRIDES = { "vallabh sumanth": ["sumanth"] };
// Pin a person's OWN board(s) by exact Asana gid. A pinned person is matched
// ONLY by gid — name matching is turned OFF for them — so no other board (a
// look-alike "Dhairya …" board, a shared master board, or stale data) can ever
// be linked to them. A pinned board also belongs ONLY to its owner.
const OWN_BOARD_GIDS = { "dhairya agarwal": ["1210376806823569"] }; // Dhairya To Do Board
function boardBelongsTo(board, assignee) {
  if (!assignee) return false;
  const name = typeof board === "string" ? board : board && board.name;
  const gid = typeof board === "string" ? null : board && board.gid;
  const a = assignee.trim().toLowerCase();
  // If THIS person is pinned, ONLY their pinned board(s) count — nothing else.
  const myPins = OWN_BOARD_GIDS[a];
  if (myPins) return gid != null && myPins.includes(String(gid));
  // A board pinned to SOMEONE ELSE never belongs to this person.
  if (gid) {
    for (const gids of Object.values(OWN_BOARD_GIDS)) {
      if (gids.includes(String(gid))) return false;
    }
  }
  // Unpinned person + unpinned board → original name match (everyone else).
  const tokens = OWN_BOARD_OVERRIDES[a] || a.split(/\s+/).filter((t) => t.length > 2);
  const bn = String(name || "").toLowerCase();
  return tokens.some((t) => bn.includes(t));
}
// Cadences tracked, in PRIORITY ORDER — each section is classified into the FIRST
// match, so "Bi-Weekly" → 'biweekly' (not 'weekly') and "Bi-Monthly" → 'bimonthly'
// (not 'monthly'). Daily is handled separately in lib/daily.js.
const KINDS = [
  { kind: "biweekly", re: /bi\W*weekly/i },
  { kind: "weekly", re: /weekly/i },
  { kind: "bimonthly", re: /bi\W*monthly/i },
  { kind: "monthly", re: /monthly/i },
  { kind: "quarterly", re: /quarter|quater|quartel/i }, // incl. misspellings (Quaterly/Quartely)
];
// The cadence for a section name, or null (skips non-cadence + "Archived" sections).
function classifyKind(name) {
  const n = (name || "").trim();
  if (!n || /^archived/i.test(n)) return null;
  for (const k of KINDS) if (k.re.test(n)) return k.kind;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** YYYY-MM-DD for an instant, in India Standard Time. */
function istDate(iso) {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

async function asanaGet(path, token, params = {}, attempt = 0) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 5) {
    const retryAfter = Number(res.headers.get("Retry-After"));
    const wait = retryAfter ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 15000);
    await sleep(wait);
    return asanaGet(path, token, params, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Asana API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function asanaGetAll(path, token, params = {}) {
  const out = [];
  let offset;
  do {
    const p = { ...params, limit: 100 };
    if (offset) p.offset = offset;
    const d = await asanaGet(path, token, p);
    out.push(...(d.data || []));
    offset = d.next_page ? d.next_page.offset : undefined;
  } while (offset);
  return out;
}

async function pool(items, limit, worker) {
  const queue = items.map((item, i) => ({ item, i }));
  const runners = Array.from({ length: Math.min(limit, queue.length || 1) }, async () => {
    while (queue.length) {
      const { item, i } = queue.shift();
      await worker(item, i);
    }
  });
  await Promise.all(runners);
}

/**
 * Rebuild the cycle history of one recurring task from its story log.
 * Returns { cycles, currentDue, hadDueChanges } where each cycle is
 *   { due: 'YYYY-MM-DD', completed: 'YYYY-MM-DD'|null, status: 'on_time'|'late'|'missed' }.
 *
 * Walk events oldest→newest, tracking the due date in effect and whether the
 * current obligation has been satisfied:
 *  - due_date_changed: if the old due was already past and never satisfied,
 *    that was a MISSED cycle; then adopt the new due (a fresh obligation).
 *  - marked_complete: closes the current obligation — on time if on/before due,
 *    else late. (Asana's auto reopen + shift after a tick is handled naturally:
 *    the obligation is already satisfied, so the follow-on due change is clean.)
 */
function reconstructCycles(stories, currentDueOn, todayIst) {
  const evts = stories
    .filter((s) => s.created_at && (s.resource_subtype === "marked_complete" || s.resource_subtype === "due_date_changed"))
    .map((s) => ({
      type: s.resource_subtype,
      when: istDate(s.created_at),
      newDue: s.new_dates && s.new_dates.due_on ? s.new_dates.due_on : null,
    }))
    .sort((a, b) => (a.when < b.when ? -1 : a.when > b.when ? 1 : 0));

  let due = null;
  let satisfied = true; // no obligation until a due date appears
  let hadDueChanges = false;
  const cycles = [];

  for (const e of evts) {
    if (e.type === "due_date_changed") {
      hadDueChanges = true;
      if (due && !satisfied && due < e.when) {
        // the previous due passed unmet, and is now being moved → missed cycle
        cycles.push({ due, completed: null, status: "missed" });
      }
      due = e.newDue;
      satisfied = false;
    } else {
      // marked_complete
      if (due) {
        cycles.push({ due, completed: e.when, status: e.when <= due ? "on_time" : "late" });
      } else {
        cycles.push({ due: null, completed: e.when, status: "on_time" });
      }
      satisfied = true;
    }
  }

  // Trailing obligation: current due in the past, still unmet → currently missed.
  const finalDue = currentDueOn || due;
  if (finalDue && !satisfied && finalDue < todayIst) {
    cycles.push({ due: finalDue, completed: null, status: "missed" });
  }

  return { cycles, currentDue: finalDue, hadDueChanges };
}

/**
 * Fetch all weekly + monthly recurring tasks across every "To do" board and
 * rebuild their cycle history.
 * Returns { roster, cycles, stats }.
 *   roster: [{ task_gid, kind, task_name, board, section, assignee, current_due, has_due }]
 *   cycles: [{ task_gid, kind, due_date, status, completed_on }]
 */
export async function fetchRecurring(token, pinnedWorkspaceGid, { maxBoards = 0, log = () => {} } = {}) {
  const todayIst = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

  const workspaces = await asanaGet("/workspaces", token, { limit: 100 });
  const wsGid = pinnedWorkspaceGid || (workspaces.data || [])[0]?.gid;
  if (!wsGid) throw new Error("No Asana workspace found for this token.");

  const allProjects = await asanaGetAll("/projects", token, { workspace: wsGid, opt_fields: "name,archived" });
  let boards = allProjects.filter((p) => !p.archived && BOARD_RE.test(p.name) && !EXCLUDE_RE.test(p.name));
  if (maxBoards > 0) boards = boards.slice(0, maxBoards);
  log(`→ ${boards.length} "To do" boards in scope${maxBoards ? ` (limited to ${maxBoards})` : ""}`);

  // 1) Every CADENCE section on each board, and its tasks. Each section is
  //    classified into exactly ONE cadence (bi-weekly before weekly, etc.).
  const tasks = []; // { gid, name, board, section, kind, assignee, due_on }
  await pool(boards, 8, async (b) => {
    let sections = [];
    try {
      sections = (await asanaGet(`/projects/${b.gid}/sections`, token, { opt_fields: "name" })).data || [];
    } catch {
      return;
    }
    for (const sec of sections) {
      const kind = classifyKind(sec.name);
      if (!kind) continue;
      let secTasks = [];
      try {
        secTasks = await asanaGetAll(`/sections/${sec.gid}/tasks`, token, {
          opt_fields: "name,assignee.name,due_on",
        });
      } catch {
        continue;
      }
      for (const t of secTasks) {
        const assignee = (t.assignee && t.assignee.name) || null;
        // Only count this recurring task for the person whose OWN board it's in.
        if (assignee && !boardBelongsTo(b, assignee)) continue;
        tasks.push({
          gid: t.gid,
          name: t.name || "(untitled)",
          board: b.name,
          section: sec.name,
          kind,
          assignee,
          due_on: t.due_on || null,
        });
      }
    }
  });
  log(`→ ${tasks.length} recurring task rows found across all cadences`);

  // 2) Walk each task's story log → cycle history. (Only assigned tasks; that's
  //    what the scorecard shows.) De-dupe by gid+kind so a multi-homed task is
  //    walked once.
  const seen = new Map(); // `${gid}|${kind}` -> task
  for (const t of tasks) {
    if (!t.assignee) continue;
    const key = `${t.gid}|${t.kind}`;
    if (!seen.has(key)) seen.set(key, t);
  }
  const uniqueTasks = [...seen.values()];

  const roster = [];
  const cycles = [];
  let dueChangeFieldHits = 0;
  let dueChangeFieldTotal = 0;
  await pool(uniqueTasks, 12, async (t) => {
    let cyc = [];
    let currentDue = t.due_on;
    try {
      const stories = await asanaGetAll(`/tasks/${t.gid}/stories`, token, {
        opt_fields: "resource_subtype,created_at,new_dates.due_on",
      });
      for (const s of stories) {
        if (s.resource_subtype === "due_date_changed") {
          dueChangeFieldTotal++;
          if (s.new_dates && s.new_dates.due_on) dueChangeFieldHits++;
        }
      }
      const r = reconstructCycles(stories, t.due_on, todayIst);
      cyc = r.cycles;
      currentDue = r.currentDue || t.due_on;
    } catch {
      // Story fetch failed — keep the task in the roster (with its current due),
      // just without rebuilt cycle history this run. Never drop it.
    }
    roster.push({
      task_gid: t.gid,
      kind: t.kind,
      task_name: t.name,
      board: t.board,
      section: t.section,
      assignee: t.assignee,
      current_due: currentDue || null,
      has_due: !!(currentDue || t.due_on),
    });
    for (const c of cyc) {
      if (!c.due) continue; // only dated cycles can be placed on the grid
      cycles.push({
        task_gid: t.gid,
        kind: t.kind,
        due_date: c.due,
        status: c.status,
        completed_on: c.completed,
      });
    }
  });

  const unassigned = tasks.filter((t) => !t.assignee).length;
  const noDue = roster.filter((r) => !r.has_due).length;
  const byKind = (k) => roster.filter((r) => r.kind === k).length;
  const perKind = {};
  for (const { kind } of KINDS) perKind[kind] = byKind(kind);
  log(
    `→ roster: ${roster.length} assigned tasks (` +
      KINDS.map(({ kind }) => `${kind} ${perKind[kind]}`).join(", ") +
      `); ${unassigned} unassigned skipped; ${noDue} have no due date`
  );
  log(`→ ${cycles.length} dated cycles rebuilt`);
  log(
    `→ due_date_changed stories with structured date: ${dueChangeFieldHits}/${dueChangeFieldTotal}` +
      (dueChangeFieldTotal && dueChangeFieldHits === 0 ? "  ⚠ new_dates.due_on came back EMPTY — on-time calc would be wrong!" : "")
  );

  return {
    roster,
    cycles,
    stats: {
      boards: boards.length,
      taskRows: tasks.length,
      assigned: roster.length,
      unassigned,
      noDue,
      weekly: byKind("weekly"),
      monthly: byKind("monthly"),
      cycles: cycles.length,
      dueChangeFieldHits,
      dueChangeFieldTotal,
    },
  };
}

/** De-dupe cycles to one row per (task, kind, due_date); missed/late beats on_time. */
export function dedupeCycles(cycles) {
  const sev = (s) => (s === "on_time" ? 0 : 1);
  const byKey = new Map();
  for (const c of cycles) {
    const k = `${c.task_gid}|${c.kind}|${c.due_date}`;
    const prev = byKey.get(k);
    if (!prev || sev(c.status) > sev(prev.status)) byKey.set(k, c);
  }
  return [...byKey.values()];
}

/**
 * Fetch + upsert weekly/monthly recurring tracking into Supabase.
 * - roster (mis_recurring_tasks): replace-on-sync (prune stale), guarded.
 * - cycles (mis_recurring_cycles): accumulate (upsert only, never pruned) so a
 *   transient story-fetch failure can never wipe a task's history.
 * Safe: if the tables don't exist yet, it logs and skips.
 */
export async function syncRecurring(sb, token, wsGid, { dryRun = false, maxBoards = 0, log = console.log } = {}) {
  const { roster, cycles, stats } = await fetchRecurring(token, wsGid, { maxBoards, log });
  const cyc = dedupeCycles(cycles);
  log(`→ ${roster.length} roster rows, ${cyc.length} unique cycles (after de-dupe)`);

  if (dryRun) return { roster, cycles: cyc, stats, wrote: false };

  const probe = await sb.from("mis_recurring_tasks").select("task_gid").limit(1);
  if (probe.error && /mis_recurring_tasks/i.test(probe.error.message)) {
    log("ℹ 'mis_recurring_tasks' not found — run supabase/recurring.sql first. Skipping recurring sync.");
    return { roster, cycles: cyc, stats, wrote: false, missingTable: true };
  }

  const syncedAt = new Date().toISOString();
  const CHUNK = 500;

  // Roster — replace-on-sync (guarded: empty fetch or upsert error never prunes).
  if (roster.length) {
    let rErr = null;
    for (let i = 0; i < roster.length; i += CHUNK) {
      const chunk = roster.slice(i, i + CHUNK).map((r) => ({ ...r, synced_at: syncedAt }));
      const { error } = await sb.from("mis_recurring_tasks").upsert(chunk, { onConflict: "task_gid,kind" });
      if (error) {
        rErr = error.message;
        log(`✗ recurring roster upsert error: ${error.message}`);
        break;
      }
    }
    if (!rErr) {
      const { error: delErr } = await sb.from("mis_recurring_tasks").delete().lt("synced_at", syncedAt);
      if (delErr) log(`✗ recurring roster prune error: ${delErr.message}`);
      else log(`✅ recurring roster synced: ${roster.length} tasks.`);
    }
  } else {
    log("⚠ recurring roster empty — kept previous roster (skipped write).");
  }

  // Cycles — accumulate (upsert only, no prune).
  let cErr = null;
  for (let i = 0; i < cyc.length; i += CHUNK) {
    const chunk = cyc.slice(i, i + CHUNK).map((c) => ({ ...c, synced_at: syncedAt }));
    const { error } = await sb.from("mis_recurring_cycles").upsert(chunk, { onConflict: "task_gid,kind,due_date" });
    if (error) {
      cErr = error.message;
      log(`✗ recurring cycles upsert error: ${error.message}`);
      break;
    }
  }
  if (!cErr) log(`✅ recurring cycles synced: ${cyc.length} rows.`);

  try {
    await sb
      .from("mis_meta")
      .upsert(
        { key: "recurring_last_synced", value: new Date().toISOString(), updated_at: new Date().toISOString() },
        { onConflict: "key" }
      );
  } catch {}

  return { roster, cycles: cyc, stats, wrote: !cErr };
}
