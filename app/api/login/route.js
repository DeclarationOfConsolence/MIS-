import { NextResponse } from "next/server";
import { verifyCredentials, signSession, SESSION_COOKIE, USER_COOKIE } from "@/lib/auth";

export async function POST(req) {
  let body = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { username, password } = body;
  if (!(await verifyCredentials(username, password))) {
    return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
  }

  const token = signSession(username);
  const res = NextResponse.json({ ok: true, username });

  const cookieOpts = {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12, // 12 hours
  };
  res.cookies.set(SESSION_COOKIE, token, cookieOpts);
  res.cookies.set(USER_COOKIE, username, { ...cookieOpts, httpOnly: false });
  return res;
}
