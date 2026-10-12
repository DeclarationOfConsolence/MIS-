import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Deprecated: the dashboard now reads pre-synced data from Supabase via
// /api/data (fast). Direct live Asana fetching is done by scripts/sync.mjs,
// which runs in GitHub Actions (no serverless time limit).
export async function GET() {
  return NextResponse.json(
    { error: "DEPRECATED", message: "Use /api/data. Data is synced to Supabase by scripts/sync.mjs." },
    { status: 410 }
  );
}
