"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function AdminPage() {
  const router = useRouter();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState("");

  // add-user form
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("nap123");
  const [role, setRole] = useState("user");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/users");
      const data = await res.json();
      if (!res.ok) {
        setErr(data);
        setUsers([]);
      } else {
        setUsers(data.users || []);
      }
    } catch (e) {
      setErr({ message: String(e) });
    } finally {
      setLoading(false);
    }
  }

  async function addUser(e) {
    e.preventDefault();
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, display_name: displayName, password, role }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg("⚠️ " + (data.error || "Failed to add user"));
      } else {
        setMsg("✅ Saved " + username);
        setUsername("");
        setDisplayName("");
        setPassword("nap123");
        setRole("user");
        load();
      }
    } finally {
      setSaving(false);
    }
  }

  async function removeUser(u) {
    if (!confirm(`Remove user "${u}"?`)) return;
    const res = await fetch("/api/users", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u }),
    });
    const data = await res.json();
    if (!res.ok) setMsg("⚠️ " + (data.error || "Failed to delete"));
    else load();
  }

  const forbidden = err && (err.error === "FORBIDDEN" || err.error === "UNAUTHORIZED");
  const noSupabase = err && err.error === "NO_SUPABASE";

  return (
    <div className="min-h-screen">
      <div className="max-w-4xl mx-auto px-4 py-6">
        <div className="bg-white dark:bg-[#141414] rounded-2xl border border-gray-200 dark:border-gray-800 p-5 shadow-sm flex items-center justify-between mb-4">
          <div>
            <h1 className="text-lg font-bold">User Management</h1>
            <p className="text-xs text-gray-400">Add or remove dashboard accounts (admin only)</p>
          </div>
          <button onClick={() => router.push("/")} className="btn-ghost">
            ← Back to dashboard
          </button>
        </div>

        {loading && <Panel>Loading…</Panel>}

        {!loading && forbidden && (
          <Panel>
            <p className="font-semibold text-red-600 dark:text-red-400">Access denied</p>
            <p className="text-sm text-gray-500 mt-1">
              Only an admin (e.g. <code>sumanth</code>) can manage users.
            </p>
          </Panel>
        )}

        {!loading && noSupabase && (
          <Panel>
            <p className="font-semibold text-amber-600 dark:text-amber-400">Supabase not connected</p>
            <p className="text-sm text-gray-500 mt-1">{err.message}</p>
          </Panel>
        )}

        {!loading && !err && (
          <>
            <Panel>
              <h2 className="font-semibold mb-3 text-sm">Add / update a user</h2>
              <form onSubmit={addUser} className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Username" value={username} onChange={setUsername} placeholder="e.g. priya" />
                <Field label="Display name" value={displayName} onChange={setDisplayName} placeholder="Priya Sharma" />
                <Field label="Password" value={password} onChange={setPassword} />
                <div>
                  <label className="filter-label">Role</label>
                  <select value={role} onChange={(e) => setRole(e.target.value)} className="filter-input">
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                  </select>
                </div>
                <div className="md:col-span-2 flex items-center gap-3">
                  <button type="submit" disabled={saving} className="btn-primary">
                    {saving ? "Saving…" : "Save user"}
                  </button>
                  {msg && <span className="text-sm text-gray-500">{msg}</span>}
                </div>
              </form>
            </Panel>

            <div className="h-4" />

            <Panel>
              <h2 className="font-semibold mb-3 text-sm">Accounts ({users.length})</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200 dark:border-gray-800">
                      <th className="py-2 px-2">Username</th>
                      <th className="py-2 px-2">Display name</th>
                      <th className="py-2 px-2">Role</th>
                      <th className="py-2 px-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.length === 0 && (
                      <tr>
                        <td colSpan={4} className="py-6 text-center text-gray-400">
                          No users yet. Add one above or run <code>npm run seed</code>.
                        </td>
                      </tr>
                    )}
                    {users.map((u) => (
                      <tr key={u.id || u.username} className="border-b border-gray-100 dark:border-gray-900">
                        <td className="py-2 px-2 font-medium">{u.username}</td>
                        <td className="py-2 px-2 text-gray-500">{u.display_name || "—"}</td>
                        <td className="py-2 px-2">
                          <span
                            className={`px-2 py-0.5 rounded-md text-xs font-semibold ${
                              u.role === "admin"
                                ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300"
                                : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                            }`}
                          >
                            {u.role}
                          </span>
                        </td>
                        <td className="py-2 px-2 text-right">
                          <button
                            onClick={() => removeUser(u.username)}
                            className="text-xs text-red-600 dark:text-red-400 hover:underline"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </>
        )}
      </div>

      <style jsx global>{`
        .btn-ghost {
          font-size: 0.8rem;
          padding: 0.4rem 0.7rem;
          border-radius: 0.6rem;
          border: 1px solid rgba(128, 128, 128, 0.25);
        }
        .btn-ghost:hover {
          border-color: #6366f1;
        }
        .btn-primary {
          font-size: 0.85rem;
          padding: 0.5rem 1rem;
          border-radius: 0.6rem;
          background: #6366f1;
          color: white;
        }
        .btn-primary:hover {
          background: #4f46e5;
        }
        .filter-label {
          display: block;
          font-size: 0.7rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.03em;
          color: #9ca3af;
          margin-bottom: 0.3rem;
        }
        .filter-input {
          width: 100%;
          border-radius: 0.6rem;
          border: 1px solid rgba(128, 128, 128, 0.3);
          background: transparent;
          padding: 0.5rem 0.6rem;
          font-size: 0.85rem;
          outline: none;
        }
        .filter-input:focus {
          box-shadow: 0 0 0 2px #6366f1;
        }
      `}</style>
    </div>
  );
}

function Panel({ children }) {
  return (
    <div className="bg-white dark:bg-[#141414] rounded-2xl border border-gray-200 dark:border-gray-800 p-6 shadow-sm">
      {children}
    </div>
  );
}

function Field({ label, value, onChange, placeholder }) {
  return (
    <div>
      <label className="filter-label">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="filter-input"
      />
    </div>
  );
}
