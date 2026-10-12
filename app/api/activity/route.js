import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = cookies().get(SESSION_COOKIE);
  if (!session || !verifySession(session.value)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const sb = getSupabase();
  if (!sb) return NextResponse.json({ error: "NO_SUPABASE" }, { status: 400 });

  const sel = "gid,name,assignee,project,projects,created_at,completed_at,due_on,completed";

  const [added, completed, removed] = await Promise.all([
    sb.from("mis_tasks").select(sel).eq("archived", false).order("created_at", { ascending: false, nullsFirst: false }).limit(50),
    sb
      .from("mis_tasks")
      .select(sel)
      .eq("completed", true)
      .eq("archived", false)
      .order("completed_at", { ascending: false, nullsFirst: false })
      .limit(50),
    sb
      .from("mis_changes")
      .select("gid,name,assignee,project,at")
      .eq("action", "removed")
      .order("at", { ascending: false })
      .limit(50),
  ]);

  return NextResponse.json({
    added: added.data || [],
    completed: completed.data || [],
    // removed may be empty if the mis_changes table isn't created yet
    removed: (removed && removed.data) || [],
    removedError: removed && removed.error ? removed.error.message : null,
  });
}
