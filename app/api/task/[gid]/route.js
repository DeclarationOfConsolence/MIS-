import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const BASE = "https://app.asana.com/api/1.0";

async function ag(path, token, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Asana ${res.status}`);
  return res.json();
}

// Fetch one task's full detail LIVE from Asana (always current).
export async function GET(req, { params }) {
  const session = cookies().get(SESSION_COOKIE);
  if (!session || !verifySession(session.value)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const token = process.env.ASANA_TOKEN;
  if (!token) return NextResponse.json({ error: "NO_TOKEN" }, { status: 400 });

  const gid = params.gid;
  const taskFields =
    "name,notes,completed,completed_at,created_at,due_on,due_at,assignee.name," +
    "projects.name,memberships.section.name,permalink_url,num_subtasks," +
    "custom_fields.name,custom_fields.display_value,tags.name";

  try {
    const [task, subtasks, stories, attachments] = await Promise.all([
      ag(`/tasks/${gid}`, token, { opt_fields: taskFields }),
      ag(`/tasks/${gid}/subtasks`, token, { opt_fields: "name,completed,assignee.name,due_on" }).catch(() => ({ data: [] })),
      ag(`/tasks/${gid}/stories`, token, { opt_fields: "text,created_at,created_by.name,type" }).catch(() => ({ data: [] })),
      ag(`/tasks/${gid}/attachments`, token, { opt_fields: "name,view_url,download_url,host" }).catch(() => ({ data: [] })),
    ]);

    const t = task.data || {};
    const comments = (stories.data || []).filter((s) => s.type === "comment");

    // Pull each subtask's stored ORIGINAL due date (for the Revised flag).
    // Only one-time subtasks are stored; others simply won't have one.
    const subGids = (subtasks.data || []).map((s) => s.gid);
    const origMap = new Map();
    if (subGids.length) {
      try {
        const sb = getSupabase();
        if (sb) {
          const { data: orig } = await sb
            .from("mis_one_time_subtasks")
            .select("gid,original_due_on")
            .in("gid", subGids);
          for (const r of orig || []) if (r.original_due_on) origMap.set(r.gid, r.original_due_on);
        }
      } catch {}
    }

    return NextResponse.json({
      task: {
        gid: t.gid,
        name: t.name,
        notes: t.notes || "",
        completed: t.completed,
        completed_at: t.completed_at,
        created_at: t.created_at,
        due_on: t.due_on || (t.due_at ? t.due_at.slice(0, 10) : null),
        assignee: t.assignee && t.assignee.name ? t.assignee.name : "Unassigned",
        projects: (t.projects || []).map((p) => p.name),
        sections: (t.memberships || []).map((m) => m.section && m.section.name).filter(Boolean),
        tags: (t.tags || []).map((x) => x.name),
        customFields: (t.custom_fields || [])
          .filter((c) => c.display_value)
          .map((c) => ({ name: c.name, value: c.display_value })),
        permalink: t.permalink_url || null,
        numSubtasks: t.num_subtasks || 0,
      },
      subtasks: (subtasks.data || []).map((s) => ({
        gid: s.gid,
        name: s.name,
        completed: s.completed,
        assignee: s.assignee && s.assignee.name ? s.assignee.name : "Unassigned",
        due_on: s.due_on || null,
        original_due_on: origMap.get(s.gid) || null,
      })),
      comments: comments.map((c) => ({
        gid: c.gid,
        text: c.text,
        author: c.created_by && c.created_by.name ? c.created_by.name : "Someone",
        created_at: c.created_at,
      })),
      attachments: (attachments.data || []).map((a) => ({
        gid: a.gid,
        name: a.name,
        url: a.view_url || a.download_url || null,
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: "ASANA_ERROR", message: String(e.message) }, { status: 500 });
  }
}
