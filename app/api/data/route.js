import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import { getSummary, getTasksPage, getAllFiltered, getLists } from "@/lib/store";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 200;

export async function GET(req) {
  const session = cookies().get(SESSION_COOKIE);
  if (!session || !verifySession(session.value)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const sp = new URL(req.url).searchParams;
  const params = {
    search: sp.get("search") || "",
    assignee: sp.get("assignee") || "All",
    project: sp.get("project") || "All",
    section: sp.get("section") || "All",
    status: sp.get("status") || "All",
    from: sp.get("from") || "",
    to: sp.get("to") || "",
  };
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  const format = sp.get("format");

  try {
    if (format === "csv") {
      const rows = await getAllFiltered(params);
      const headers = ["Task", "Assignee", "Projects", "Sections", "Status", "Due", "Completed At"];
      const t = new Date().toISOString().slice(0, 10);
      const lines = [headers.join(",")];
      for (const r of rows) {
        const overdue = !r.completed && r.due_on && r.due_on < t;
        const status = r.completed ? "Completed" : overdue ? "Overdue" : "Open";
        const projects = (r.projects && r.projects.length ? r.projects : r.project ? [r.project] : []).join(" | ");
        const sections = (r.sections && r.sections.length ? r.sections : r.section ? [r.section] : []).join(" | ");
        const row = [r.name, r.assignee, projects, sections, status, r.due_on || "", r.completed_at || ""]
          .map((v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`)
          .join(",");
        lines.push(row);
      }
      return new NextResponse(lines.join("\n"), {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": "attachment; filename=napchief-mis-export.csv",
        },
      });
    }

    const [summary, pageData, lists] = await Promise.all([
      getSummary(params),
      getTasksPage(params, page, PAGE_SIZE),
      getLists(),
    ]);

    return NextResponse.json({
      kpis: summary.kpis,
      perAssignee: summary.perAssignee,
      perProject: summary.perProject,
      tasks: pageData.tasks,
      page,
      pageSize: PAGE_SIZE,
      total: pageData.total,
      totalTasks: lists.taskCount,
      lists: { assignees: lists.assignees, projects: lists.projects, sections: lists.sections },
      lastSynced: lists.lastSynced,
    });
  } catch (e) {
    if (String(e.message).includes("NO_SUPABASE")) {
      return NextResponse.json(
        {
          error: "NO_SUPABASE",
          message: "Supabase is not connected. Check SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local.",
        },
        { status: 400 }
      );
    }
    if (String(e.message).includes("mis_summary") || String(e.message).includes("mis_filter_lists")) {
      return NextResponse.json(
        {
          error: "NO_FUNCTIONS",
          message:
            "Database functions not installed yet. Run supabase/functions.sql in the Supabase SQL Editor, then reload.",
        },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: "DB_ERROR", message: String(e.message) }, { status: 500 });
  }
}
