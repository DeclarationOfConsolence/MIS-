// ============================================================
// Daily to-do completion tracking.
//
// Reads, from every person's "To do" board, the DAILY section's tasks,
// then walks each task's Asana STORY LOG to find every "marked_complete"
// event — who ticked it and exactly when. Because the story log is
// permanent, this survives the daily reset (task reopens for tomorrow)
// and any skipped syncs (it always backfills the full history).
//
// One completion = one (task, day-in-IST): a tick counts for the day the
// task was completed, regardless of who clicked it. Ticking twice in a day
// still counts once.
//
// It ALSO captures the full roster of daily tasks (with each task's
// assignee), so a task that was never ticked still shows up as 0/6.
// Tasks are grouped by ASSIGNEE; unassigned daily tasks are skipped.
//
// This module is self-contained and does NOT touch lib/asana.js.
// ============================================================

const BASE = "https://app.asana.com/api/1.0";

// Which boards/sections count as "daily to-do" tracking:
const BOARD_RE = /to.?do/i; // "To do", "To-Do", "TO DO", …
const SECTION_RE = /daily/i; // "Daily", "DAILY", "Daily Tasks", …
const EXCLUDE_RE = /sample|test|template/i; // skip sample/test/template boards

// A daily task only counts for the person whose OWN board it's in — never a
// shared/team board (e.g. "Inventory's TO-DO Board"). A board belongs to a
// person if its name contains the person's name (override for odd cases like
// Vallabh Sumanth, whose board is named "Sumanth …").
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** YYYY-MM-DD for the given instant, in India Standard Time. */
function istDate(iso) {
  // en-CA formats as YYYY-MM-DD
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

/** Page through an Asana list endpoint, collecting all results. */
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

/** Run async workers over a list with limited concurrency. */
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
 * Fetch every daily completion across all "To do" boards.
 * Returns { boards, dailyTasks, completions, stats }.
 *  - completions: [{ task_gid, task_name, board, section, person, completed_at, completed_date }]
 */
export async function fetchDailyCompletions(token, pinnedWorkspaceGid, { log = () => {} } = {}) {
  const workspaces = await asanaGet("/workspaces", token, { limit: 100 });
  const wsGid = pinnedWorkspaceGid || (workspaces.data || [])[0]?.gid;
  if (!wsGid) throw new Error("No Asana workspace found for this token.");

  // 1) All non-archived "To do" boards (minus samples/tests).
  const allProjects = await asanaGetAll("/projects", token, {
    workspace: wsGid,
    opt_fields: "name,archived",
  });
  const boards = allProjects.filter(
    (p) => !p.archived && BOARD_RE.test(p.name) && !EXCLUDE_RE.test(p.name)
  );
  const excludedSamples = allProjects.filter(
    (p) => !p.archived && BOARD_RE.test(p.name) && EXCLUDE_RE.test(p.name)
  ).length;
  log(`→ ${boards.length} "To do" boards in scope (${excludedSamples} sample/test boards excluded)`);

  // 2) Each board's DAILY section + its tasks.
  const dailyTasks = []; // { gid, name, board, section }
  let noDaily = 0;
  await pool(boards, 8, async (b) => {
    let sections = [];
    try {
      sections = (await asanaGet(`/projects/${b.gid}/sections`, token, { opt_fields: "name" })).data || [];
    } catch {
      return;
    }
    const daily = sections.find((s) => SECTION_RE.test(s.name) && !/^archived/i.test((s.name || "").trim()));
    if (!daily) {
      noDaily++;
      return;
    }
    let tasks = [];
    try {
      tasks = await asanaGetAll(`/sections/${daily.gid}/tasks`, token, {
        opt_fields: "name,assignee.name",
      });
    } catch {
      return;
    }
    for (const t of tasks) {
      const assignee = (t.assignee && t.assignee.name) || null;
      // Only count this daily task for the person whose OWN board it's in.
      if (assignee && !boardBelongsTo(b, assignee)) continue;
      dailyTasks.push({
        gid: t.gid,
        name: t.name || "(untitled)",
        board: b.name,
        section: daily.name,
        assignee,
      });
    }
  });
  log(`→ ${dailyTasks.length} daily tasks across ${boards.length - noDaily} boards with a DAILY section`);

  // 3) Each task's story log → every "marked_complete" event.
  const completions = [];
  await pool(dailyTasks, 12, async (t) => {
    let stories = [];
    try {
      stories = await asanaGetAll(`/tasks/${t.gid}/stories`, token, {
        opt_fields: "resource_subtype,created_at,created_by.name",
      });
    } catch {
      return;
    }
    for (const s of stories) {
      if (s.resource_subtype !== "marked_complete" || !s.created_at) continue;
      completions.push({
        task_gid: t.gid,
        task_name: t.name,
        board: t.board,
        section: t.section,
        person: (s.created_by && s.created_by.name) || "Unknown",
        completed_at: s.created_at,
        completed_date: istDate(s.created_at),
      });
    }
  });
  log(`→ ${completions.length} completion events found`);

  // 4) Full roster of daily tasks that HAVE an assignee. These are shown on
  // the scorecard even when never ticked (as 0/6). "Assignee only" attribution:
  // unassigned daily tasks are skipped (counted, so gaps are visible in the log).
  // De-duped by task_gid: a task multi-homed into several "To do" boards is the
  // SAME task, so it must appear once — else the DB write rejects the duplicate
  // primary key ("cannot affect row a second time") and saves nothing.
  const rosterByGid = new Map();
  for (const t of dailyTasks) {
    if (!t.assignee) continue;
    if (!rosterByGid.has(t.gid)) {
      rosterByGid.set(t.gid, {
        task_gid: t.gid,
        task_name: t.name,
        board: t.board,
        section: t.section,
        assignee: t.assignee,
      });
    }
  }
  const roster = [...rosterByGid.values()];
  const assignedEntries = dailyTasks.filter((t) => t.assignee).length;
  const unassigned = dailyTasks.length - assignedEntries;
  const dupes = assignedEntries - roster.length;
  log(
    `→ roster: ${roster.length} unique assigned daily tasks ` +
      `(${unassigned} unassigned skipped, ${dupes} multi-homed duplicates collapsed)`
  );

  return {
    boards: boards.map((b) => b.name),
    dailyTaskCount: dailyTasks.length,
    roster,
    completions,
    stats: {
      boards: boards.length,
      excludedSamples,
      noDaily,
      dailyTasks: dailyTasks.length,
      roster: roster.length,
      unassigned,
    },
  };
}

/** De-duplicate completions to one row per (task, person, day). */
export function dedupeCompletions(completions) {
  const byKey = new Map();
  for (const c of completions) {
    const key = `${c.task_gid}|${c.person}|${c.completed_date}`;
    const prev = byKey.get(key);
    // keep the earliest tick of the day
    if (!prev || c.completed_at < prev.completed_at) byKey.set(key, c);
  }
  return [...byKey.values()];
}

/**
 * Fetch + upsert daily completions into Supabase.
 * Safe: if the table doesn't exist yet, it logs and skips (never throws
 * in a way that would break the main sync).
 */
export async function syncDailyCompletions(sb, token, wsGid, { dryRun = false, log = console.log } = {}) {
  const { completions, roster, stats, boards } = await fetchDailyCompletions(token, wsGid, { log });
  const rows = dedupeCompletions(completions).map((c) => ({ ...c, synced_at: new Date().toISOString() }));
  log(`→ ${rows.length} unique daily completions (after de-dupe by task+person+day)`);

  if (dryRun) {
    return { rows, roster, stats, boards, wrote: false };
  }

  // Make sure the table exists before writing.
  const probe = await sb.from("mis_daily_completions").select("task_gid").limit(1);
  if (probe.error && /mis_daily_completions/i.test(probe.error.message)) {
    log("ℹ 'mis_daily_completions' table not found — run supabase/daily.sql first. Skipping daily sync.");
    return { rows, roster, stats, boards, wrote: false, missingTable: true };
  }

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sb
      .from("mis_daily_completions")
      .upsert(chunk, { onConflict: "task_gid,person,completed_date" });
    if (error) {
      log(`✗ daily upsert error: ${error.message}`);
      return { rows, roster, stats, boards, wrote: false, error: error.message };
    }
  }

  // ---- Roster of all (assigned) daily tasks, so never-ticked tasks show as 0/6.
  // Replace-on-sync: upsert everything seen this run (same synced_at), then
  // delete rows NOT seen this run (tasks removed from a DAILY section). Guarded
  // so a failed/empty fetch can never wipe the roster.
  const syncedAt = new Date().toISOString();
  const rosterProbe = await sb.from("mis_daily_tasks").select("task_gid").limit(1);
  if (rosterProbe.error && /mis_daily_tasks/i.test(rosterProbe.error.message)) {
    log("ℹ 'mis_daily_tasks' table not found — run supabase/daily.sql first. Skipping roster write.");
  } else if (roster.length) {
    let rosterError = null;
    for (let i = 0; i < roster.length; i += CHUNK) {
      const chunk = roster.slice(i, i + CHUNK).map((r) => ({ ...r, synced_at: syncedAt }));
      const { error } = await sb.from("mis_daily_tasks").upsert(chunk, { onConflict: "task_gid" });
      if (error) {
        rosterError = error.message;
        log(`✗ roster upsert error: ${error.message}`);
        break;
      }
    }
    if (!rosterError) {
      const { error: delErr } = await sb.from("mis_daily_tasks").delete().lt("synced_at", syncedAt);
      if (delErr) log(`✗ roster prune error: ${delErr.message}`);
      else log(`✅ Daily roster synced: ${roster.length} tasks.`);
    }
  } else {
    log("⚠ roster empty — kept previous roster (skipped roster write).");
  }

  // Save a "last synced" marker for the daily tracker.
  try {
    await sb
      .from("mis_meta")
      .upsert(
        { key: "daily_last_synced", value: new Date().toISOString(), updated_at: new Date().toISOString() },
        { onConflict: "key" }
      );
  } catch {}

  log(`✅ Daily completions synced: ${rows.length} rows.`);
  return { rows, roster, stats, boards, wrote: true };
}
