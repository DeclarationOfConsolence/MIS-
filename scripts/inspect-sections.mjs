// READ-ONLY: enumerate every distinct section name across all "To do" boards,
// with how many boards use each. Reveals the full cadence landscape
// (Daily / Weekly / Bi-Weekly / Monthly / Bi-Monthly / Quarterly / …).
// Writes nothing.
//   node --env-file=.env.local scripts/inspect-sections.mjs

const BASE = "https://app.asana.com/api/1.0";
const token = process.env.ASANA_TOKEN;
const pinnedWs = process.env.ASANA_WORKSPACE_GID || "";
if (!token) {
  console.error("✗ Missing ASANA_TOKEN");
  process.exit(1);
}

const BOARD_RE = /to.?do/i;
const EXCLUDE_RE = /sample|test|template/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function aget(path, params = {}, attempt = 0) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if ((res.status === 429 || res.status >= 500) && attempt < 5) {
    const ra = Number(res.headers.get("Retry-After"));
    await sleep(ra ? ra * 1000 : Math.min(1000 * 2 ** attempt, 15000));
    return aget(path, params, attempt + 1);
  }
  if (!res.ok) throw new Error(`Asana ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}
async function agetAll(path, params = {}) {
  const out = [];
  let offset;
  do {
    const p = { ...params, limit: 100 };
    if (offset) p.offset = offset;
    const d = await aget(path, p);
    out.push(...(d.data || []));
    offset = d.next_page ? d.next_page.offset : undefined;
  } while (offset);
  return out;
}

const ws = pinnedWs || (await aget("/workspaces", { limit: 100 })).data?.[0]?.gid;
const projects = await agetAll("/projects", { workspace: ws, opt_fields: "name,archived" });
const boards = projects.filter((p) => !p.archived && BOARD_RE.test(p.name) && !EXCLUDE_RE.test(p.name));

const counts = new Map(); // section name -> # boards
for (const b of boards) {
  let sections = [];
  try {
    sections = (await aget(`/projects/${b.gid}/sections`, { opt_fields: "name" })).data || [];
  } catch {
    continue;
  }
  const seen = new Set();
  for (const s of sections) {
    const n = (s.name || "").trim();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    counts.set(n, (counts.get(n) || 0) + 1);
  }
}

const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
console.log(`Boards scanned: ${boards.length}`);
console.log(`Distinct section names: ${sorted.length}\n`);
console.log("#boards  section name");
console.log("-------  ------------");
for (const [n, c] of sorted) console.log(`${String(c).padStart(6)}  ${n}`);

// Quick cadence classification
const cad = (n) =>
  /daily/i.test(n) ? "DAILY"
  : /bi.?weekly/i.test(n) || /fortnight/i.test(n) ? "BI-WEEKLY"
  : /weekly/i.test(n) ? "WEEKLY"
  : /bi.?monthly/i.test(n) ? "BI-MONTHLY"
  : /monthly/i.test(n) ? "MONTHLY"
  : /quarter/i.test(n) ? "QUARTERLY"
  : /one[ -]?time/i.test(n) ? "ONE-TIME"
  : null;
const byCad = new Map();
for (const [n, c] of sorted) {
  const k = cad(n) || "(other)";
  if (!byCad.has(k)) byCad.set(k, []);
  byCad.get(k).push(`${n} (${c})`);
}
console.log("\n=== grouped by cadence ===");
for (const [k, list] of byCad) console.log(`\n${k}:\n   ${list.join("\n   ")}`);

console.log("\n✅ Done (read-only).");
