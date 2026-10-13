// Asana sometimes returns a different capitalization of the same person's name
// across different tasks/boards (e.g. "Lalit chauhan" vs "Lalit Chauhan") —
// without this, they'd split into two separate "assignees" everywhere in the
// dashboard. Canonicalize to Title Case so the same person always merges into
// one row, consistently across the one-time, daily, and recurring syncs.
export function canonicalAssigneeName(name) {
  const trimmed = (name || "").trim().replace(/\s+/g, " ");
  if (!trimmed) return trimmed;
  return trimmed
    .split(" ")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}
