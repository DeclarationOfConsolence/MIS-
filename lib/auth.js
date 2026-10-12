import crypto from "crypto";
import bcrypt from "bcryptjs";
import { getSupabase, USERS_TABLE } from "./supabase";

const SECRET = process.env.SESSION_SECRET || "dev-secret-change-me";

export const SESSION_COOKIE = "mis_session";
export const USER_COOKIE = "mis_user";

/** Env-based accounts (fallback when Supabase is not configured). */
export function getEnvAccounts() {
  const raw =
    process.env.MIS_ACCOUNTS ||
    "sumanth:nap123,user2:nap123,user3:nap123,user4:nap123,user5:nap123";
  const map = {};
  for (const pair of raw.split(",")) {
    const [u, p] = pair.split(":");
    if (u && p) map[u.trim()] = p.trim();
  }
  return map;
}

/**
 * Verify a username/password.
 * - If Supabase is configured -> check the mis_users table (bcrypt).
 * - Otherwise -> fall back to env accounts (plain compare).
 */
export async function verifyCredentials(username, password) {
  if (!username || !password) return false;

  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from(USERS_TABLE)
      .select("username,password_hash")
      .eq("username", username)
      .maybeSingle();
    if (error || !data) return false;
    try {
      return bcrypt.compareSync(password, data.password_hash);
    } catch {
      return false;
    }
  }

  const accounts = getEnvAccounts();
  return accounts[username] === password;
}

/** Get a user's profile (display name + role). */
export async function getUserProfile(username) {
  if (!username) return null;

  const sb = getSupabase();
  if (sb) {
    const { data } = await sb
      .from(USERS_TABLE)
      .select("username,display_name,role")
      .eq("username", username)
      .maybeSingle();
    return data || null;
  }

  const accounts = getEnvAccounts();
  if (accounts[username] !== undefined) {
    return {
      username,
      display_name: username,
      role: username === "sumanth" ? "admin" : "user",
    };
  }
  return null;
}

/** Sign a username -> "username.hmac" session token. */
export function signSession(username) {
  const sig = crypto.createHmac("sha256", SECRET).update(username).digest("hex");
  return `${username}.${sig}`;
}

/** Validate a session token created by signSession. Returns username or null. */
export function verifySession(token) {
  if (!token || !token.includes(".")) return null;
  const idx = token.lastIndexOf(".");
  const username = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac("sha256", SECRET).update(username).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? username : null;
}
