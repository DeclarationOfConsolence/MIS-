// Sync the whole Asana workspace into Supabase (mis_tasks + mis_meta).
//
// Local:   npm run sync           (loads .env.local automatically)
// CI:      node scripts/sync.mjs  (env vars provided by GitHub Actions)
//
// Takes several minutes for large workspaces (Asana rate limits).

import { createClient } from "@supabase/supabase-js";
import { fetchWorkspaceData, taskExists, getSubtasks, getProjects, getProjectTasksWithCustomFields } from "../lib/asana.js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const token = process.env.ASANA_TOKEN;

if (!url || !key) {
  console.error("✗ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!token || token.startsWith("paste")) {
  console.error("✗ Missing ASANA_TOKEN");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

console.log("→ Fetching the whole Asana workspace (this can take several minutes)…");
const t0 = Date.now();
const d = await fetchWorkspaceData(token, process.env.ASANA_WORKSPACE_GID || "");
console.log(
  `→ Fetched ${d.tasks.length} tasks, ${d.members.length} members in ${((Date.now() - t0) / 1000).toFixed(0)}s`
);

const runStart = new Date().toISOString();

// ---- "One-Time" classification ----------------------------------
// Default: a task is one-time if it lives in a board named "...One Time...".
// Overrides: people whose one-time work is in a differently-named board.
// (matched case-insensitively, trimmed)
const norm = (s) => String(s || "").trim().toLowerCase();
const ONE_TIME_OVERRIDES = {
  "vallabh sumanth": ["sumanth's work tracker"], // use ONLY these as his one-time
};
function isOneTime(assignee, projects) {
  const override = ONE_TIME_OVERRIDES[norm(assignee)];
  const projs = (projects || []).map(norm);
  if (override) return projs.some((p) => override.includes(p));
  return projs.some((p) => /one[ -]?time/.test(p));
}
// The section a task sits in WITHIN its one-time board (exact Asana section).
function oneTimeSection(assignee, memberships) {
  const override = ONE_TIME_OVERRIDES[norm(assignee)];
  for (const m of memberships || []) {
    const pn = norm(m.project);
    if (override ? override.includes(pn) : /one[ -]?time/.test(pn)) return m.section || null;
  }
  return null;
}

// The section a task sits in WITHIN the assignee's OWN board (board named after
// the person — e.g. "Dipti's To-Do Board"). Ignores shared/team boards like
// "Inventory's TO-DO Board". Prefers the To-Do board, then one-time, then any.
const OWN_BOARD_OVERRIDES = {
  "vallabh sumanth": ["sumanth"], // his boards are named "Sumanth ..."
};
function ownSection(assignee, memberships) {
  const ov = OWN_BOARD_OVERRIDES[norm(assignee)];
  const tokens = ov || norm(assignee).split(/\s+/).filter((t) => t.length > 2);
  const owns = (board) => {
    const bn = norm(board);
    return tokens.some((t) => bn.includes(t));
  };
  const owned = (memberships || []).filter((m) => owns(m.project));
  if (!owned.length) return null;
  const todo = owned.find((m) => /to-?do/i.test(m.project));
  if (todo) return todo.section || null;
  const ot = owned.find((m) => /one[ -]?time/i.test(m.project));
  if (ot) return ot.section || null;
  return owned[0].section || null;
}
// -----------------------------------------------------------------

// Tasks are already unique per gid (fetchWorkspaceData groups multi-homed
// tasks). Map to rows, keeping the full projects + sections lists. A safety
// de-dupe guards against any stray duplicate gid in one upsert batch.
const byGid = new Map();
for (const t of d.tasks) {
  if (!byGid.has(t.gid)) {
    byGid.set(t.gid, {
      gid: t.gid,
      name: t.name,
      assignee: t.assignee,
      project: t.project,
      projects: t.projects || (t.project ? [t.project] : []),
      section: t.section,
      sections: t.sections || (t.section ? [t.section] : []),
      completed: t.completed,
      completed_at: t.completed_at,
      created_at: t.created_at,
      due_on: t.due_on,
      is_one_time: isOneTime(t.assignee, t.projects || (t.project ? [t.project] : [])),
      one_time_section: oneTimeSection(t.assignee, t.memberships),
      own_section: ownSection(t.assignee, t.memberships),
      archived: t.archived || false,
      project_gids: t.projectGids || [], // which projects this task was seen in (safe-prune provenance)
      synced_at: runStart,
    });
  }
}
const rows = [...byGid.values()];
console.log(`→ ${rows.length} unique tasks (multi-project tasks counted once)`);

// The one-time feature adds an `is_one_time` column. If it hasn't been created
// yet, sync WITHOUT it so the sync never fails. (Run supabase/functions.sql to enable.)
const probe = await sb.from("mis_tasks").select("is_one_time").limit(1);
if (probe.error && /is_one_time/i.test(probe.error.message)) {
  console.log("ℹ 'is_one_time' column not found — syncing without it. Run the SQL to enable one-time completion.");
  for (const r of rows) delete r.is_one_time;
}

// original_due_on: keep the FIRST-seen due date per task (for revision tracking).
// Preserve existing originals; new tasks get their current due date as the baseline.
const odProbe = await sb.from("mis_tasks").select("original_due_on").limit(1);
if (odProbe.error && /original_due_on/i.test(odProbe.error.message)) {
  console.log("ℹ 'original_due_on' column not found — skipping revision tracking. Run the SQL to enable.");
  for (const r of rows) delete r.original_due_on;
} else {
  const existing = new Map();
  let f = 0;
  for (;;) {
    const { data } = await sb.from("mis_tasks").select("gid,original_due_on").range(f, f + 999);
    if (!data || data.length === 0) break;
    for (const r of data) if (r.original_due_on) existing.set(r.gid, r.original_due_on);
    if (data.length < 1000) break;
    f += 1000;
  }
  for (const r of rows) r.original_due_on = existing.get(r.gid) || r.due_on;
  console.log(`→ revision baselines: ${existing.size} preserved, ${rows.length - existing.size} new`);
}

// one_time_section column (exact section from the one-time board) — resilient if missing
const otsProbe = await sb.from("mis_tasks").select("one_time_section").limit(1);
if (otsProbe.error && /one_time_section/i.test(otsProbe.error.message)) {
  console.log("ℹ 'one_time_section' column not found — run the SQL to enable exact section grouping.");
  for (const r of rows) delete r.one_time_section;
}

// own_section column (section from the assignee's OWN board) — resilient if missing
const ownProbe = await sb.from("mis_tasks").select("own_section").limit(1);
if (ownProbe.error && /own_section/i.test(ownProbe.error.message)) {
  console.log("ℹ 'own_section' column not found — run the SQL to enable own-board section filtering.");
  for (const r of rows) delete r.own_section;
}

// archived column — resilient if missing (run the SQL to enable archived hiding)
const archProbe = await sb.from("mis_tasks").select("archived").limit(1);
if (archProbe.error && /archived/i.test(archProbe.error.message)) {
  console.log("ℹ 'archived' column not found — syncing without it. Run the SQL to enable archived hiding.");
  for (const r of rows) delete r.archived;
}

// project_gids column — provenance for SAFE pruning. If missing, we fall back to
// "only delete on a fully-complete fetch" (still safe). Run the SQL to enable
// precise per-project pruning.
let hasProjectGids = true;
const pgProbe = await sb.from("mis_tasks").select("project_gids").limit(1);
if (pgProbe.error && /project_gids/i.test(pgProbe.error.message)) {
  hasProjectGids = false;
  console.log("ℹ 'project_gids' column not found — precise pruning disabled until you run the SQL (delete only on complete fetches for now).");
  for (const r of rows) delete r.project_gids;
}

const CHUNK = 500;
let upsertOk = true;
for (let i = 0; i < rows.length; i += CHUNK) {
  const chunk = rows.slice(i, i + CHUNK);
  const { error } = await sb.from("mis_tasks").upsert(chunk, { onConflict: "gid" });
  if (error) {
    console.error("✗ Upsert error:", error.message);
    upsertOk = false;
    process.exitCode = 1; // fail the run, but keep going so downstream steps still run
    break; // a partial upsert would make un-upserted rows look "removed" — skip the prune
  }
  console.log(`  upserted ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
}

// ---- SAFE PRUNE -----------------------------------------------------------
// Deletion rules, ordered so a partial/buggy fetch can NEVER wipe live tasks:
//  1. Only prune on a FULLY COMPLETE fetch (every project loaded). On a complete
//     fetch, a task absent from the DB-vs-fetch diff is genuinely gone; a task
//     that merely MOVED projects was still seen, so it isn't a candidate. If
//     anything failed, skip the prune (tasks linger briefly but are never falsely
//     deleted — the safe direction).
//  2. Refuse to prune if the project LIST shrank a lot vs last run (guards a
//     silently-truncated /projects response from masquerading as "complete").
//  3. Provenance shield: even on a "complete" fetch, never delete a known row
//     whose project isn't in this run's okSet.
//  4. Hard safety valve on the delete count; abort (never crash) if it's huge or
//     if the DB count can't be read.
if (!upsertOk) {
  console.warn("⛔ PRUNE SKIPPED — upsert did not fully complete; not deleting this run.");
} else {
  const okSet = new Set(d.okProjectGids || []);
  const failedCount = (d.failedProjects || []).length;
  if (failedCount) {
    console.warn(`⚠ ${failedCount}/${d.projectsTotal} projects failed to fetch this run — their tasks are protected.`);
  }

  // Guard against a silently-truncated project list: compare this run's project
  // count to the previous run's. A big unexplained drop => treat as incomplete.
  const { data: ptRow } = await sb.from("mis_meta").select("value").eq("key", "projects_total").maybeSingle();
  const prevProjectsTotal = ptRow ? Number(ptRow.value) || 0 : 0;
  const projectListShrank = prevProjectsTotal > 0 && (d.projectsTotal || 0) < prevProjectsTotal * 0.9;
  if (projectListShrank) {
    console.warn(
      `⛔ PRUNE SKIPPED — project list dropped ${prevProjectsTotal} → ${d.projectsTotal} (>10%); refusing to delete on a possibly-truncated fetch.`
    );
  }

  const canPrune = d.complete === true && rows.length > 0 && !projectListShrank;
  if (!canPrune && !projectListShrank) {
    if (d.complete !== true)
      console.warn("⛔ PRUNE SKIPPED — fetch not fully complete; no tasks deleted this run (live data preserved).");
    else if (rows.length === 0) console.warn("⛔ PRUNE SKIPPED — fetch returned 0 tasks; not deleting this run.");
  }

  // Candidate rows = present in DB but not re-stamped this run (paginated; the
  // Supabase client caps a single select at 1000 rows).
  let candidates = [];
  if (canPrune) {
    const sel = hasProjectGids ? "gid,name,assignee,project,project_gids" : "gid,name,assignee,project";
    let f = 0;
    for (;;) {
      const { data, error } = await sb.from("mis_tasks").select(sel).lt("synced_at", runStart).range(f, f + 999);
      if (error) {
        console.error("⚠ removed-detect error — skipping prune for safety:", error.message);
        candidates = null;
        break;
      }
      if (!data || data.length === 0) break;
      candidates.push(...data);
      if (data.length < 1000) break;
      f += 1000;
    }
  }

  // Provenance shield: only delete a known-provenance row if every one of its
  // projects loaded cleanly (protects rows whose project was silently dropped).
  let toDelete = [];
  if (canPrune && candidates && candidates.length) {
    toDelete = candidates.filter((r) => {
      const pgs = Array.isArray(r.project_gids) ? r.project_gids : null;
      if (pgs && pgs.length > 0) return pgs.every((g) => okSet.has(g));
      return true; // null/legacy provenance — safe on a verified-complete fetch
    });
  }

  // Hard safety valve: abort (don't crash) if the delete is abnormally large, or
  // if the DB count can't be read to judge it.
  if (toDelete.length) {
    const { count: dbCount, error: cntErr } = await sb.from("mis_tasks").select("*", { count: "exact", head: true });
    const { data: appr } = await sb.from("mis_meta").select("value").eq("key", "approve_bulk_prune").maybeSingle();
    const bulkApproved = appr && String(appr.value) === "true";
    if (cntErr || dbCount == null) {
      console.error("🚨 PRUNE ABORTED — could not read DB count; refusing to delete without a safety baseline.");
      process.exitCode = 1;
      toDelete = [];
    } else {
      const maxPct = Number(process.env.SYNC_MAX_PRUNE_PCT) || 0.02;
      const absFloor = Number(process.env.SYNC_MAX_PRUNE_ABS) || 300;
      const limit = Math.max(absFloor, Math.ceil(dbCount * maxPct));
      if (toDelete.length > limit && !bulkApproved) {
        console.error(
          `🚨 PRUNE ABORTED — would delete ${toDelete.length}/${dbCount} tasks (> limit ${limit}). Skipping deletion to protect data. ` +
            `If this is a real bulk cleanup, set mis_meta key 'approve_bulk_prune'='true' and re-run. Upserts kept; downstream syncs continue.`
        );
        process.exitCode = 1; // surface as a failed run, but do NOT exit (let daily/recurring run)
        toDelete = [];
      } else if (bulkApproved && toDelete.length > limit) {
        // consume the one-shot approval only when it actually authorized a large prune
        await sb.from("mis_meta").upsert({ key: "approve_bulk_prune", value: "false", updated_at: runStart }, { onConflict: "key" });
      }
    }
  }

  // Final truth gate: re-confirm each candidate is ACTUALLY gone from Asana before
  // deleting. This covers a project that returned an empty/partial 200 this run
  // (no error to catch) — its still-live tasks come back as existing and are kept.
  // Only tasks Asana reports as 404 (deleted) survive to the delete below.
  if (toDelete.length) {
    const confirmedGone = [];
    let ci = 0;
    const reconfirm = async () => {
      while (ci < toDelete.length) {
        const r = toDelete[ci++];
        const exists = await taskExists(token, r.gid);
        if (!exists) confirmedGone.push(r);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, toDelete.length) }, reconfirm));
    const spared = toDelete.length - confirmedGone.length;
    if (spared > 0) console.log(`→ re-confirm: kept ${spared} task(s) still present in Asana (not deleted).`);
    toDelete = confirmedGone;
  }

  // Log to mis_changes + delete ONLY the gated set (by gid, so a stale-synced_at
  // row we chose to KEEP is never accidentally removed).
  if (toDelete.length) {
    const changeRows = toDelete.map((r) => ({
      gid: r.gid,
      name: r.name,
      assignee: r.assignee,
      project: r.project,
      action: "removed",
      at: runStart,
    }));
    for (let i = 0; i < changeRows.length; i += 500) {
      const { error } = await sb.from("mis_changes").insert(changeRows.slice(i, i + 500));
      if (error) {
        console.error("⚠ change-log error (is mis_changes table created?):", error.message);
        break;
      }
    }
    const gids = toDelete.map((r) => r.gid);
    for (let i = 0; i < gids.length; i += 500) {
      const { error } = await sb.from("mis_tasks").delete().in("gid", gids.slice(i, i + 500));
      if (error) {
        console.error("⚠ cleanup error:", error.message);
        break;
      }
    }
    console.log(`→ pruned ${gids.length} tasks (verified gone on a complete fetch), logged as removed`);
  } else {
    console.log("→ prune: 0 tasks deleted this run.");
  }

  // Remember this run's project count for next run's truncation guard — but ONLY
  // on a non-shrunk run, so a truncated fetch can't ratchet the baseline downward.
  if (!projectListShrank) {
    await sb
      .from("mis_meta")
      .upsert({ key: "projects_total", value: String(d.projectsTotal || 0), updated_at: runStart }, { onConflict: "key" });
  }
}

// Save member roster + last-synced time
await sb
  .from("mis_meta")
  .upsert({ key: "members", value: JSON.stringify(d.members), updated_at: runStart }, { onConflict: "key" });
await sb
  .from("mis_meta")
  .upsert({ key: "last_synced", value: runStart, updated_at: runStart }, { onConflict: "key" });

// ---- (removed) Daily snapshot step ----
// This used to feed the Planned-vs-Actual "Fixed" mode. That mode is gone now
// that Planned End Date is frozen at sync time, so nothing reads mis_due_snapshots
// any more. The table can be dropped in Supabase whenever you like; harmless to keep.

// ---- One-time SUBTASKS (counted as extra one-time tasks, per subtask assignee) ----
// For every ONE-TIME parent that has subtasks (num_subtasks>0), fetch its direct
// subtasks, attribute each to the SUBTASK's own assignee, inherit the parent's
// one-time section, and store in mis_one_time_subtasks (read ONLY by the One-Time
// scorecard). Fully guarded: missing table or fetch errors never break the sync,
// and stale rows are pruned only when every parent fetched cleanly.
try {
  const subProbe = await sb.from("mis_one_time_subtasks").select("gid").limit(1);
  if (subProbe.error && /mis_one_time_subtasks/i.test(subProbe.error.message)) {
    console.log("ℹ 'mis_one_time_subtasks' table not found — skipping one-time subtasks. Run supabase/functions.sql to enable.");
  } else {
    const parents = d.tasks.filter((t) => {
      const projs = t.projects && t.projects.length ? t.projects : t.project ? [t.project] : [];
      return (t.num_subtasks || 0) > 0 && isOneTime(t.assignee, projs);
    });
    console.log(`→ one-time subtasks: ${parents.length} one-time parents have subtasks — fetching (all nested levels)…`);

    // Preserve each subtask's FIRST-seen due date (for revision tracking), the
    // same way main tasks do — so we never overwrite the original with the current.
    const existingSubOrig = new Map();
    {
      let f = 0;
      for (;;) {
        const { data } = await sb.from("mis_one_time_subtasks").select("gid,original_due_on").range(f, f + 999);
        if (!data || data.length === 0) break;
        for (const r of data) if (r.original_due_on) existingSubOrig.set(r.gid, r.original_due_on);
        if (data.length < 1000) break;
        f += 1000;
      }
    }

    const subRows = [];
    let subFetchOk = true;
    let si = 0;
    const SUB_CONC = Number(process.env.ASANA_CONCURRENCY) || 16;
    const subWorker = async () => {
      while (si < parents.length) {
        const t = parents[si++];
        try {
          const subs = await getSubtasks(token, t.gid);
          const sec = oneTimeSection(t.assignee, t.memberships);
          for (const s of subs) {
            subRows.push({
              gid: s.gid,
              parent_gid: t.gid,
              name: s.name || "(untitled subtask)",
              assignee: s.assignee && s.assignee.name ? s.assignee.name : "Unassigned",
              completed: Boolean(s.completed),
              completed_at: s.completed_at || null,
              due_on: s.due_on || (s.due_at ? s.due_at.slice(0, 10) : null),
              original_due_on:
                existingSubOrig.get(s.gid) || s.due_on || (s.due_at ? s.due_at.slice(0, 10) : null),
              created_at: s.created_at || null,
              one_time_section: sec,
              archived: t.archived || false,
              synced_at: runStart,
            });
          }
        } catch (e) {
          subFetchOk = false;
          console.error(`⚠ subtask fetch failed for ${t.gid}: ${(e && e.message) || e}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SUB_CONC, parents.length || 1) }, subWorker));

    // de-dupe by gid (a subtask can't legitimately repeat, but guard the upsert)
    const subByGid = new Map();
    for (const r of subRows) if (!subByGid.has(r.gid)) subByGid.set(r.gid, r);
    const finalSub = [...subByGid.values()];

    let subUpsertOk = true;
    for (let i = 0; i < finalSub.length; i += CHUNK) {
      const { error } = await sb.from("mis_one_time_subtasks").upsert(finalSub.slice(i, i + CHUNK), { onConflict: "gid" });
      if (error) {
        console.error("⚠ one-time subtask upsert error:", error.message);
        subUpsertOk = false;
        break;
      }
    }
    if (subUpsertOk) {
      console.log(`→ one-time subtasks: ${finalSub.length} subtasks upserted across ${parents.length} parents.`);
      // Replace-on-sync prune — only when EVERY parent fetched cleanly, so a
      // transient fetch failure can never wipe a parent's subtasks.
      if (subFetchOk) {
        const { error: delErr } = await sb.from("mis_one_time_subtasks").delete().lt("synced_at", runStart);
        if (delErr) console.error("⚠ one-time subtask prune error:", delErr.message);
      } else {
        console.warn("⚠ one-time subtask prune SKIPPED — some subtask fetches failed (stale rows kept, safe).");
      }
    }
  }
} catch (e) {
  console.error("⚠ one-time subtasks step skipped:", e.message);
}

// ---- Daily to-do completion tracking (additive, fully guarded) ----
// Reads each person's "To do" -> DAILY section story logs. If anything
// here fails (or the table isn't created yet), it NEVER breaks the main sync.
try {
  const { syncDailyCompletions } = await import("../lib/daily.js");
  console.log("→ Syncing daily to-do completions…");
  await syncDailyCompletions(sb, token, process.env.ASANA_WORKSPACE_GID || "", { log: console.log });
} catch (e) {
  console.error("⚠ daily-completions step skipped:", e.message);
}

// ---- Weekly / Monthly recurring to-do tracking (additive, fully guarded) ----
// Reads each "To do" board's WEEKLY + MONTHLY sections. Independent of the
// daily step; if it fails (or tables aren't created yet), it never breaks sync.
try {
  const { syncRecurring } = await import("../lib/recurring.js");
  console.log("→ Syncing weekly/monthly recurring to-dos…");
  await syncRecurring(sb, token, process.env.ASANA_WORKSPACE_GID || "", { log: console.log });
} catch (e) {
  console.error("⚠ recurring step skipped:", e.message);
}

// ---- Planned / Actual end dates for ALL one-time boards — additive, guarded ----
// Fills mis_tasks.planned_end_date / actual_end_date from the "Planned End Date"
// + "Actual End date" custom fields, across every one-time board. Never breaks sync.
try {
  const paProbe = await sb.from("mis_tasks").select("planned_end_date").limit(1);
  if (paProbe.error && /planned_end_date/i.test(paProbe.error.message)) {
    console.log("ℹ 'planned_end_date' column not found — skipping planned/actual. Run the SQL to enable.");
  } else {
    const wsg = process.env.ASANA_WORKSPACE_GID || d.workspaceGid;
    const projects = await getProjects(token, wsg);
    // Scan boards named "One Time" AND the OVERRIDE boards (e.g. "Sumanth's work
    // tracker") — those are one-time by rule, not by name, so a name-only filter
    // would skip them and never capture their Planned/Actual End Date fields.
    const overrideBoards = new Set(Object.values(ONE_TIME_OVERRIDES).flat().map(norm));
    const oneTimeBoards = projects.filter(
      (p) => !p.archived && (/one[ -]?time/i.test(p.name) || overrideBoards.has(norm(p.name)))
    );
    // FREEZE: load gids that ALREADY have a planned_end_date so the sync never
    // overwrites it. Existing tasks keep their current planned date; only tasks
    // that don't have one yet get it captured (once), then it's frozen forever.
    const frozenPlanned = new Set();
    for (let f = 0; ; f += 1000) {
      const { data, error } = await sb.from("mis_tasks").select("gid").not("planned_end_date", "is", null).range(f, f + 999);
      if (error || !data || data.length === 0) break;
      for (const r of data) frozenPlanned.add(r.gid);
      if (data.length < 1000) break;
    }
    console.log(`→ planned_end_date: ${frozenPlanned.size} already frozen (kept as-is, never overwritten).`);
    const pickDate = (t, nameLc) => {
      // A board can have DUPLICATE custom fields with the SAME name (one filled,
      // one empty). Match ALL of them and prefer the one that actually has a value,
      // so we never grab the hidden empty duplicate.
      const matches = (t.custom_fields || []).filter((c) => (c.name || "").trim().toLowerCase() === nameLc);
      const cf = matches.find((c) => c.date_value && (c.date_value.date || c.date_value.date_time)) || matches[0];
      const dv = cf && cf.date_value && (cf.date_value.date || cf.date_value.date_time);
      return dv ? String(dv).slice(0, 10) : null;
    };
    let updated = 0;
    let scanned = 0;
    // Fetch every one-time board's custom-field tasks CONCURRENTLY (was sequential).
    const PA_CONC = Number(process.env.ASANA_CONCURRENCY) || 16;
    const ops = []; // per-task updates to apply: { gid, upd }
    let bi = 0;
    const boardWorker = async () => {
      while (bi < oneTimeBoards.length) {
        const board = oneTimeBoards[bi++];
        let paTasks = [];
        try {
          paTasks = await getProjectTasksWithCustomFields(token, board.gid);
        } catch (e) {
          console.error(`⚠ planned/actual fetch failed for "${board.name}": ${(e && e.message) || e}`);
          continue;
        }
        scanned += paTasks.length;
        for (const t of paTasks) {
          const planned = pickDate(t, "planned end date");
          const actual = pickDate(t, "actual end date");
          if (planned == null && actual == null) continue; // only write tasks that have the fields
          // FREEZE the planned end date: set it only if this task doesn't already have
          // one (first capture); never overwrite. Actual end date always reflects current.
          const upd = { actual_end_date: actual };
          if (!frozenPlanned.has(t.gid) && planned != null) upd.planned_end_date = planned;
          ops.push({ gid: t.gid, upd });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PA_CONC, oneTimeBoards.length || 1) }, boardWorker));
    // Apply the per-task updates CONCURRENTLY too (was one sequential round-trip each).
    let oi = 0;
    const upWorker = async () => {
      while (oi < ops.length) {
        const { gid, upd } = ops[oi++];
        const { error } = await sb.from("mis_tasks").update(upd).eq("gid", gid);
        if (!error) updated++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(12, ops.length || 1) }, upWorker));
    console.log(`→ Planned/Actual end dates: updated ${updated} tasks (scanned ${scanned}) across ${oneTimeBoards.length} one-time boards.`);
  }
} catch (e) {
  console.error("⚠ planned/actual step skipped:", e.message);
}

console.log(`✅ Sync complete in ${((Date.now() - t0) / 1000).toFixed(0)}s. Last synced: ${runStart}`);
