import { getSupabase } from "./supabase";

let listsCache = { at: 0, data: null };
const TTL = 5 * 60 * 1000; // 5 min

function sbOrThrow() {
  const sb = getSupabase();
  if (!sb) throw new Error("NO_SUPABASE");
  return sb;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Next calendar day for a YYYY-MM-DD string (used for the created-date upper bound).
function nextDay(d) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
}

/** Apply dashboard filters to a PostgREST query builder (for the task list). */
function applyFilters(q, p) {
  if (p.assignee && p.assignee !== "All") q = q.eq("assignee", p.assignee);
  // projects/sections are jsonb arrays -> use jsonb-contains (cs) with a JSON value
  if (p.project && p.project !== "All") q = q.filter("projects", "cs", JSON.stringify([p.project]));
  // Section = the section in the person's OWN board (not borrowed from a shared board)
  if (p.section && p.section !== "All") q = q.eq("own_section", p.section);
  if (p.status === "Completed") q = q.eq("completed", true);
  else if (p.status === "Open") q = q.eq("completed", false);
  else if (p.status === "Overdue") q = q.eq("completed", false).lt("due_on", today());
  // Calendar matches by ADDED/CREATED date (created_at), using IST day boundaries.
  if (p.from) q = q.gte("created_at", `${p.from}T00:00:00+05:30`);
  if (p.to) q = q.lt("created_at", `${nextDay(p.to)}T00:00:00+05:30`);
  if (p.search) {
    const s = p.search.replace(/[(),*]/g, " ").trim();
    if (s) q = q.or(`name.ilike.*${s}*,assignee.ilike.*${s}*`);
  }
  // Hide archived by default; show ONLY archived when Status = 'Archived'.
  q = p.status === "Archived" ? q.eq("archived", true) : q.eq("archived", false);
  return q;
}

function rpcArgs(p) {
  return {
    p_assignee: p.assignee && p.assignee !== "All" ? p.assignee : null,
    p_project: p.project && p.project !== "All" ? p.project : null,
    p_section: p.section && p.section !== "All" ? p.section : null,
    p_status: p.status && p.status !== "All" && p.status !== "Archived" ? p.status : null,
    p_from: p.from || null,
    p_to: p.to || null,
    p_search: p.search || null,
    p_archived: p.status === "Archived",
  };
}

/** KPIs + per-assignee + per-project, computed in the database. */
export async function getSummary(p) {
  const sb = sbOrThrow();
  const { data, error } = await sb.rpc("mis_summary", rpcArgs(p));
  if (error) throw new Error(error.message);
  return data || { kpis: { total: 0, completed: 0, open: 0, overdue: 0 }, perAssignee: [], perProject: [] };
}

/** One page of tasks + the total matching count. */
export async function getTasksPage(p, page, pageSize) {
  const sb = sbOrThrow();
  const startIdx = (page - 1) * pageSize;
  let q = sb
    .from("mis_tasks")
    .select("gid,name,assignee,project,projects,section,sections,completed,due_on", { count: "exact" });
  q = applyFilters(q, p);
  q = q
    .order("completed", { ascending: true })
    .order("due_on", { ascending: true, nullsFirst: false })
    .range(startIdx, startIdx + pageSize - 1);
  const { data, count, error } = await q;
  if (error) throw new Error(error.message);
  return { tasks: data || [], total: count || 0 };
}

/** All matching tasks (for CSV export). */
export async function getAllFiltered(p) {
  const sb = sbOrThrow();
  const rows = [];
  const size = 1000;
  let from = 0;
  for (;;) {
    let q = sb
      .from("mis_tasks")
      .select("name,assignee,project,projects,section,sections,completed,due_on,completed_at");
    q = applyFilters(q, p).range(from, from + size - 1);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < size) break;
    from += size;
  }
  return rows;
}

/** Dropdown lists + total count + last-synced (cached 5 min). */
export async function getLists() {
  if (listsCache.data && Date.now() - listsCache.at < TTL) return listsCache.data;
  const sb = sbOrThrow();
  const { data, error } = await sb.rpc("mis_filter_lists");
  if (error) throw new Error(error.message);

  // merge in the full member roster (so people with 0 tasks still appear)
  const { data: meta } = await sb.from("mis_meta").select("value").eq("key", "members").maybeSingle();
  let members = [];
  try {
    members = JSON.parse((meta && meta.value) || "[]");
  } catch {}

  const assignees = new Set([...(data.assignees || []), ...members]);
  const lists = {
    assignees: ["All", ...Array.from(assignees).filter(Boolean).sort()],
    projects: ["All", ...(data.projects || []).filter(Boolean)],
    sections: ["All", ...(data.sections || []).filter(Boolean)],
    taskCount: data.taskCount || 0,
    lastSynced: data.lastSynced || null,
  };
  listsCache = { at: Date.now(), data: lists };
  return lists;
}

export function clearListsCache() {
  listsCache = { at: 0, data: null };
}
