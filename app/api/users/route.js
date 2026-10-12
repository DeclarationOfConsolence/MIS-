import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { verifySession, getUserProfile, SESSION_COOKIE } from "@/lib/auth";
import { getSupabase, USERS_TABLE } from "@/lib/supabase";

export const dynamic = "force-dynamic";

async function requireAdmin() {
  const session = cookies().get(SESSION_COOKIE);
  const username = session ? verifySession(session.value) : null;
  if (!username) return { error: "UNAUTHORIZED", status: 401 };
  const profile = await getUserProfile(username);
  if (!profile || profile.role !== "admin") return { error: "FORBIDDEN", status: 403 };
  return { username };
}

function noSupabase() {
  return NextResponse.json(
    {
      error: "NO_SUPABASE",
      message:
        "Supabase is not configured yet. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env.local, run the schema, then restart.",
    },
    { status: 400 }
  );
}

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const sb = getSupabase();
  if (!sb) return noSupabase();

  const { data, error } = await sb
    .from(USERS_TABLE)
    .select("id,username,display_name,role,created_at")
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ users: data || [] });
}

export async function POST(req) {
  const auth = await requireAdmin();
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const sb = getSupabase();
  if (!sb) return noSupabase();

  let body = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const username = (body.username || "").trim();
  const password = body.password || "";
  const display_name = (body.display_name || username).trim();
  const role = body.role === "admin" ? "admin" : "user";

  if (!username || !password) {
    return NextResponse.json({ error: "Username and password are required" }, { status: 400 });
  }

  const password_hash = bcrypt.hashSync(password, 10);
  const { error } = await sb
    .from(USERS_TABLE)
    .upsert({ username, password_hash, display_name, role }, { onConflict: "username" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req) {
  const auth = await requireAdmin();
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const sb = getSupabase();
  if (!sb) return noSupabase();

  let body = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const username = (body.username || "").trim();
  if (!username) return NextResponse.json({ error: "username required" }, { status: 400 });
  if (username === auth.username) {
    return NextResponse.json({ error: "You cannot delete your own account." }, { status: 400 });
  }

  const { error } = await sb.from(USERS_TABLE).delete().eq("username", username);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
