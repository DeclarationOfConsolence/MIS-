import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifySession, getUserProfile, SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = cookies().get(SESSION_COOKIE);
  const username = session ? verifySession(session.value) : null;
  if (!username) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const profile = await getUserProfile(username);
  return NextResponse.json({
    username,
    display_name: (profile && profile.display_name) || username,
    role: (profile && profile.role) || "user",
  });
}
