// Seed the mis_users table with the initial accounts.
// Run with:  npm run seed   (loads .env.local automatically)

import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("\n✗ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local\n");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

// ---- EDIT THESE NAMES ----
// All passwords are nap123. sumanth is the admin (can manage users).
const PASSWORD = "nap123";
const USERS = [
  { username: "sumanth", display_name: "Sumanth", role: "admin" },
  { username: "user2", display_name: "User 2", role: "user" },
  { username: "user3", display_name: "User 3", role: "user" },
  { username: "user4", display_name: "User 4", role: "user" },
  { username: "user5", display_name: "User 5", role: "user" },
];
// --------------------------

let ok = 0;
for (const u of USERS) {
  const password_hash = bcrypt.hashSync(PASSWORD, 10);
  const { error } = await sb
    .from("mis_users")
    .upsert({ ...u, password_hash }, { onConflict: "username" });
  if (error) {
    console.error(`✗ ${u.username}: ${error.message}`);
  } else {
    console.log(`✓ ${u.username} (${u.role})`);
    ok++;
  }
}
console.log(`\nDone. ${ok}/${USERS.length} users seeded. Password for all: ${PASSWORD}\n`);
