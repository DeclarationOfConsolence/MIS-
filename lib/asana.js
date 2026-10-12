const BASE = "https://app.asana.com/api/1.0";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

  // Handle rate limiting (429) and transient server errors with backoff.
  // Higher ceiling (8 attempts) + longer cap (30s) so a rate-limit storm doesn't
  // exhaust retries and drop a whole project (which the sync would then delete).
  if ((res.status === 429 || res.status >= 500) && attempt < 8) {
    const retryAfter = Number(res.headers.get("Retry-After"));
    const wait = retryAfter ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 30000);
    await sleep(wait);
    return asanaGet(path, token, params, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Asana API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export async function getWorkspaces(token) {
  const d = await asanaGet("/workspaces", token, { limit: 100 });
  return d.data || [];
}

/**
 * Returns FALSE only when Asana definitively reports the task as gone (HTTP 404).
 * For a 200 (still exists), a permissions response, or ANY transient error, returns
 * TRUE — so the sync never deletes a task on uncertainty. Used as the final truth
 * gate before pruning, so an empty/partial project fetch can't wipe live tasks.
 */
export async function taskExists(token, gid, attempt = 0) {
  try {
    const res = await fetch(`${BASE}/tasks/${gid}?opt_fields=gid`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (res.status === 404) return false; // definitively deleted
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      const wait = retryAfter ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 15000);
      await sleep(wait);
      return taskExists(token, gid, attempt + 1);
    }
    return true; // exists, or non-404 error → keep (safe)
  } catch {
    return true; // network error → keep (safe)
  }
}

export async function getProjects(token, workspaceGid) {
  // Retry the WHOLE listing up to 3 times. A failure here must NOT yield a partial
  // project list — that would make the sync think whole projects "disappeared" and
  // delete their tasks. So on repeated failure we throw, aborting the sync safely
  // (no deletion happens) rather than returning a truncated list.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const projects = [];
      let offset;
      do {
        const params = { workspace: workspaceGid, limit: 100, opt_fields: "name,archived" };
        if (offset) params.offset = offset;
        const d = await asanaGet("/projects", token, params);
        projects.push(...(d.data || []));
        offset = d.next_page ? d.next_page.offset : undefined;
      } while (offset);
      return projects; // keep archived projects too — tasks get an `archived` flag (hidden by default)
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

export async function getTasksForProject(token, projectGid) {
  const opt =
    "name,completed,completed_at,created_at,due_on,due_at,assignee.name,num_subtasks," +
    "memberships.section.name,memberships.project.name";
  // Retry the WHOLE project (from page 1) up to 3 times. Otherwise a transient
  // failure on page N would throw away the project's already-fetched pages and
  // make every task in it look "deleted" to the sync. Only after 3 full attempts
  // fail do we rethrow — the caller records the project as failed (never silently
  // dropped) so its tasks are protected from deletion.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const tasks = [];
      let offset;
      do {
        const params = { limit: 100, opt_fields: opt };
        if (offset) params.offset = offset;
        const d = await asanaGet(`/projects/${projectGid}/tasks`, token, params);
        tasks.push(...(d.data || []));
        offset = d.next_page ? d.next_page.offset : undefined;
      } while (offset);
      return tasks;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/**
 * Fetch ALL nested subtasks of a task — direct subtasks, THEIR subtasks, and so
 * on to any depth — flattened into one list. Each level's listing is retried up
 * to 3 times; a repeated failure throws (caller records it so a transient error
 * never silently drops subtasks). Asana subtasks form a tree, so no cycles.
 */
export async function getSubtasks(token, taskGid) {
  const opt = "name,completed,completed_at,created_at,due_on,due_at,assignee.name,num_subtasks";
  const out = [];
  // Fetch ONE task's direct children (with retry). Recursion is kept OUT of the
  // retry loop so a deep failure never re-fetches an already-collected level.
  const fetchDirect = async (gid) => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const level = [];
        let offset;
        do {
          const params = { limit: 100, opt_fields: opt };
          if (offset) params.offset = offset;
          const d = await asanaGet(`/tasks/${gid}/subtasks`, token, params);
          level.push(...(d.data || []));
          offset = d.next_page ? d.next_page.offset : undefined;
        } while (offset);
        return level;
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastErr;
  };
  const walk = async (gid) => {
    const level = await fetchDirect(gid);
    for (const st of level) {
      out.push(st);
      if ((st.num_subtasks || 0) > 0) await walk(st.gid); // recurse into deeper subtasks
    }
  };
  await walk(taskGid);
  return out;
}

// Fetch a project's tasks WITH their custom-field date values — used by the
// Arjun planned-vs-actual test to read "Planned End Date" / "Actual End date".
export async function getProjectTasksWithCustomFields(token, projectGid) {
  const tasks = [];
  let offset;
  const opt =
    "name,completed,completed_at," +
    "custom_fields.name,custom_fields.display_value,custom_fields.date_value";
  do {
    const params = { limit: 100, opt_fields: opt };
    if (offset) params.offset = offset;
    const d = await asanaGet(`/projects/${projectGid}/tasks`, token, params);
    tasks.push(...(d.data || []));
    offset = d.next_page ? d.next_page.offset : undefined;
  } while (offset);
  return tasks;
}

export async function getWorkspaceUsers(token, workspaceGid) {
  const users = [];
  let offset;
  do {
    const params = { workspace: workspaceGid, limit: 100, opt_fields: "name" };
    if (offset) params.offset = offset;
    const d = await asanaGet("/users", token, params);
    users.push(...(d.data || []));
    offset = d.next_page ? d.next_page.offset : undefined;
  } while (offset);
  return users;
}

/** Run async workers over a list with limited concurrency. */
async function pool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length || 1) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/** Fetch the whole workspace and return a flat, dashboard-ready task list. */
export async function fetchWorkspaceData(token, pinnedWorkspaceGid) {
  const workspaces = await getWorkspaces(token);
  if (!workspaces.length) throw new Error("No Asana workspaces found for this token.");

  const wsGid = pinnedWorkspaceGid || workspaces[0].gid;
  const workspace = workspaces.find((w) => w.gid === wsGid) || workspaces[0];

  const projects = await getProjects(token, workspace.gid);

  // Full member roster (so everyone shows in the filter, even with 0 tasks)
  let members = [];
  try {
    members = (await getWorkspaceUsers(token, workspace.gid))
      .map((u) => u.name)
      .filter(Boolean);
  } catch (e) {
    // not fatal — fall back to assignees found on tasks
  }

  // A task can belong to several projects (multi-homed). We keep ONE record per
  // task gid and collect every project + section it appears in.
  // Paid Asana allows ~1,500 requests/min, so we fetch many projects at once.
  // (429 rate-limit responses are retried with backoff in asanaGet.)
  const CONCURRENCY = Number(process.env.ASANA_CONCURRENCY) || 16;
  const byGid = new Map();
  const okProjectGids = new Set(); // projects whose tasks were FULLY fetched this run
  const failedProjects = []; // projects that failed even after retries — NEVER ignored
  await pool(projects, CONCURRENCY, async (p) => {
    try {
      const tasks = await getTasksForProject(token, p.gid);
      for (const t of tasks) {
        const membership =
          (t.memberships || []).find((m) => m.project && m.project.gid === p.gid) ||
          (t.memberships || [])[0];
        const section = membership && membership.section ? membership.section.name : "No section";
        // Is THIS board appearance archived? (an "Archived" section, or an archived board)
        const apprArchived = Boolean(p.archived) || /^archived/i.test((section || "").trim());
        let rec = byGid.get(t.gid);
        if (!rec) {
          rec = {
            gid: t.gid,
            name: t.name || "(untitled task)",
            completed: Boolean(t.completed),
            completed_at: t.completed_at || null,
            created_at: t.created_at || null,
            due_on: t.due_on || (t.due_at ? t.due_at.slice(0, 10) : null),
            assignee: t.assignee && t.assignee.name ? t.assignee.name : "Unassigned",
            num_subtasks: t.num_subtasks || 0, // how many subtasks this task has (for one-time subtask counting)
            projects: [],
            sections: [],
            memberships: [], // [{ project, section }] — which section in which board
            projectGids: [], // gids of every project this task was SEEN in (for safe pruning)
          };
          byGid.set(t.gid, rec);
        }
        if (p.name && !rec.projects.includes(p.name)) rec.projects.push(p.name);
        if (section && !rec.sections.includes(section)) rec.sections.push(section);
        if (!rec.projectGids.includes(p.gid)) rec.projectGids.push(p.gid);
        rec.memberships.push({ project: p.name, section, archived: apprArchived });
      }
      // Mark success ONLY after every task/page of this project was processed.
      okProjectGids.add(p.gid);
    } catch (e) {
      // Do NOT swallow silently: a swallowed failure makes a live project look
      // empty, and the sync would then DELETE all its tasks. Record it instead,
      // and log it so it is visible in the sync output / CI.
      failedProjects.push({ gid: p.gid, name: p.name, error: String((e && e.message) || e).slice(0, 200) });
      console.error(`⚠ project fetch FAILED — ${p.name || p.gid}: ${(e && e.message) || e}`);
    }
  });

  const flat = [...byGid.values()].map((r) => ({
    ...r,
    project: r.projects[0] || "No project", // primary (for display fallback)
    section: r.sections[0] || "No section",
    // Archived only if EVERY place it lives is archived (no live appearance anywhere).
    archived: r.memberships.length > 0 && r.memberships.every((m) => m.archived),
  }));

  if (failedProjects.length) {
    console.error(
      `⚠ ${failedProjects.length}/${projects.length} projects failed to fetch — sync will NOT delete tasks that live in them.`
    );
  }

  return {
    workspace: workspace.name,
    workspaceGid: workspace.gid,
    fetchedAt: new Date().toISOString(),
    projects: projects.map((p) => p.name),
    members,
    tasks: flat, // each task carries projectGids
    // ---- fetch-completeness contract (consumed by scripts/sync.mjs) ----
    okProjectGids: [...okProjectGids],
    failedProjects,
    projectsTotal: projects.length,
    projectsFetched: okProjectGids.size,
    complete: failedProjects.length === 0,
  };
}
