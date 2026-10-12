import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifySession, getUserProfile, SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

// The full sync takes ~8 min — too long for a serverless function. So the
// "Sync now" button triggers the GitHub Actions workflow (which has no such
// limit). Requires GITHUB_DISPATCH_TOKEN + GITHUB_REPO env vars.
export async function POST() {
  const session = cookies().get(SESSION_COOKIE);
  const username = session ? verifySession(session.value) : null;
  if (!username) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const profile = await getUserProfile(username);
  if (!profile || profile.role !== "admin") {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const ghToken = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_REPO; // e.g. "Spaceman784/MSI-Tracker"
  if (!ghToken || !repo) {
    return NextResponse.json(
      {
        error: "NOT_CONFIGURED",
        message:
          "Manual sync needs GITHUB_DISPATCH_TOKEN + GITHUB_REPO. It still auto-syncs hourly — or run `npm run sync` locally.",
      },
      { status: 400 }
    );
  }

  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event_type: "sync-asana" }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return NextResponse.json({ error: "GH_ERROR", message: t.slice(0, 200) }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    message: "Sync started in the background. Refresh in a few minutes to see updated data.",
  });
}
