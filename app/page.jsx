"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { StatusDonut, PerAssigneeBar, PerProjectBar } from "@/components/Charts";
import Logo from "@/components/Logo";

const TABS = ["One Time Tasks", "To-Do Tasks", "Planned vs Actual", "Tasks", "Team", "Charts", "Activity", "Overview"];

export default function Dashboard() {
  const router = useRouter();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState("One Time Tasks");
  const [dark, setDark] = useState(false);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState("user");
  const [syncing, setSyncing] = useState(false);
  const [detailGid, setDetailGid] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [activity, setActivity] = useState(null);
  const [performance, setPerformance] = useState(null);
  const [daily, setDaily] = useState(null);
  const [recurring, setRecurring] = useState(null);
  const [todoPerson, setTodoPerson] = useState(null);
  const [perfPerson, setPerfPerson] = useState(null);
  const [perfTasks, setPerfTasks] = useState(null);
  const [planned, setPlanned] = useState(null);
  const [arjunPA, setArjunPA] = useState(null); // Arjun planned-vs-actual TEST
  const [plannedFrom, setPlannedFrom] = useState(""); // empty = all time
  const [plannedTo, setPlannedTo] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);

  // filters
  const [search, setSearch] = useState("");
  const [fAssignee, setFAssignee] = useState("All");
  const [fProject, setFProject] = useState("All");
  const [fSection, setFSection] = useState("All");
  const [fStatus, setFStatus] = useState("All");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((me) => {
        if (me) {
          setUsername(me.display_name || me.username);
          setRole(me.role || "user");
        }
      })
      .catch(() => { });
  }, []);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (search) p.set("search", search);
    if (fAssignee !== "All") p.set("assignee", fAssignee);
    if (fProject !== "All") p.set("project", fProject);
    if (fSection !== "All") p.set("section", fSection);
    if (fStatus !== "All") p.set("status", fStatus);
    if (dateFrom) p.set("from", dateFrom);
    if (dateTo) p.set("to", dateTo);
    p.set("page", String(page));
    return p.toString();
  }, [search, fAssignee, fProject, fSection, fStatus, dateFrom, dateTo, page]);

  // debounced fetch on any filter change
  const debounceRef = useRef(null);
  useEffect(() => {
    setLoading(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetch(`/api/data?${query}`)
        .then(async (r) => {
          const j = await r.json();
          if (!r.ok) {
            setErr(j);
            setData(null);
          } else {
            setErr(null);
            setData(j);
          }
        })
        .catch((e) => setErr({ message: String(e) }))
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  // reset to page 1 whenever a non-page filter changes
  useEffect(() => {
    setPage(1);
  }, [search, fAssignee, fProject, fSection, fStatus, dateFrom, dateTo]);

  // load a task's full detail when one is selected
  useEffect(() => {
    if (!detailGid) return;
    setDetailLoading(true);
    setDetail(null);
    fetch(`/api/task/${detailGid}`)
      .then((r) => r.json())
      .then((j) => setDetail(j))
      .catch(() => setDetail({ error: "Failed to load task" }))
      .finally(() => setDetailLoading(false));
  }, [detailGid]);

  // auto-refresh every 60s (silent — no loading flash)
  const queryRef = useRef("");
  useEffect(() => {
    queryRef.current = query;
  }, [query]);
  useEffect(() => {
    const id = setInterval(() => setRefreshTick((t) => t + 1), 60 * 60 * 1000); // auto-refresh hourly
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (refreshTick === 0) return;
    fetch(`/api/data?${queryRef.current}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j) {
          setData(j);
          setErr(null);
        }
      })
      .catch(() => { });
  }, [refreshTick]);

  // load the Activity feed when the tab is open (and on each refresh tick)
  useEffect(() => {
    if (tab !== "Activity") return;
    let cancelled = false;
    fetch("/api/activity")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j) setActivity(j);
      })
      .catch(() => { });
    return () => {
      cancelled = true;
    };
  }, [tab, refreshTick]);

  // load the Performance scorecard when the tab is open (and on each refresh tick)
  useEffect(() => {
    if (tab !== "One Time Tasks") return;
    let cancelled = false;
    const p = new URLSearchParams();
    if (dateFrom) p.set("from", dateFrom);
    if (dateTo) p.set("to", dateTo);
    fetch(`/api/performance?${p.toString()}`)
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) setPerformance(j);
      })
      .catch(() => { });
    return () => {
      cancelled = true;
    };
  }, [tab, refreshTick, dateFrom, dateTo]);

  // load Planned vs Actual when the tab is open (and when its date range changes)
  useEffect(() => {
    if (tab !== "Planned vs Actual") return;
    let cancelled = false;
    const p = new URLSearchParams();
    if (plannedFrom) p.set("from", plannedFrom);
    if (plannedTo) p.set("to", plannedTo);
    fetch(`/api/planned?${p.toString()}`)
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) setPlanned(j);
      })
      .catch(() => { });
    // Arjun planned-vs-actual TEST — filtered by Planned End Date
    const pa = new URLSearchParams();
    if (plannedFrom) pa.set("from", plannedFrom);
    if (plannedTo) pa.set("to", plannedTo);
    setArjunPA(null);
    fetch(`/api/planned/arjun?${pa.toString()}`)
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) setArjunPA(j);
      })
      .catch(() => { });
    return () => {
      cancelled = true;
    };
  }, [tab, plannedFrom, plannedTo, refreshTick]);

  // load the Daily to-do scorecard when the tab is open (and on each refresh tick)
  useEffect(() => {
    if (tab !== "To-Do Tasks") return;
    let cancelled = false;
    setDaily(null);
    setRecurring(null);
    // Reuse the top Calendar range: empty = current week / last-N periods.
    const qp = new URLSearchParams();
    if (dateFrom) qp.set("from", dateFrom);
    if (dateTo) qp.set("to", dateTo);
    const qs = qp.toString() ? `?${qp.toString()}` : "";
    fetch(`/api/daily${qs}`)
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) setDaily(j);
      })
      .catch((e) => {
        if (!cancelled) setDaily({ error: "DB_ERROR", message: String(e) });
      });
    fetch(`/api/recurring${qs}`)
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) setRecurring(j);
      })
      .catch((e) => {
        if (!cancelled) setRecurring({ error: "DB_ERROR", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [tab, refreshTick, dateFrom, dateTo]);

  // load a person's one-time tasks for the Performance drill-down
  // (respects the Calendar = ADDED/CREATED date window too)
  useEffect(() => {
    if (!perfPerson) return;
    setPerfTasks(null);
    const p = new URLSearchParams({ assignee: perfPerson.assignee });
    if (dateFrom) p.set("from", dateFrom);
    if (dateTo) p.set("to", dateTo);
    fetch(`/api/performance/tasks?${p.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setPerfTasks(j ? j.tasks : []))
      .catch(() => setPerfTasks([]));
  }, [perfPerson, dateFrom, dateTo]);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("mis-theme", next ? "dark" : "light");
    } catch { }
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    router.replace("/login");
  }

  async function syncNow() {
    setSyncing(true);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const j = await res.json();
      alert(j.message || j.error || "Done");
    } finally {
      setSyncing(false);
    }
  }

  function resetFilters() {
    setSearch("");
    setFAssignee("All");
    setFProject("All");
    setFSection("All");
    setFStatus("All");
    setDateFrom("");
    setDateTo("");
  }

  const lists = data?.lists || { assignees: ["All"], projects: ["All"], sections: ["All"] };
  const kpis = data?.kpis || { total: 0, completed: 0, open: 0, overdue: 0, archived: 0 };
  const perAssignee = data?.perAssignee || [];
  const perProject = data?.perProject || [];
  const tasks = data?.tasks || [];
  const total = data?.total || 0;
  const pageSize = data?.pageSize || 200;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="min-h-screen">
      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="bg-white dark:bg-[#141414] rounded-2xl border border-gray-200 dark:border-gray-800 p-5 shadow-sm flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <Logo size={44} />
            <div>
              <h1 className="text-lg font-bold leading-tight">NapChief MIS Performance Dashboard</h1>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                {data?.lastSynced
                  ? `Last synced ${new Date(data.lastSynced).toLocaleString()} • ${data.totalTasks?.toLocaleString()} tasks`
                  : "Asana tracking"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {username && (
              <span className="text-xs text-gray-400 dark:text-gray-500 mr-1 hidden sm:inline">{username}</span>
            )}
            <button onClick={toggleTheme} className="btn-ghost" title="Toggle theme">
              {dark ? "☀️ Light" : "🌙 Dark"}
            </button>
            <a href={`/api/data?${query}&format=csv`} className="btn-ghost">
              ⇩ Export CSV
            </a>
            {role === "admin" && (
              <>
                <button onClick={syncNow} disabled={syncing} className="btn-ghost">
                  {syncing ? "Syncing…" : "⟳ Sync now"}
                </button>
                <button onClick={() => router.push("/admin")} className="btn-ghost">
                  ⚙ Users
                </button>
              </>
            )}
            <button onClick={logout} className="btn-primary">
              Logout
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="bg-white dark:bg-[#141414] rounded-2xl border border-gray-200 dark:border-gray-800 p-4 shadow-sm mb-4">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <div className="col-span-2 md:col-span-3 lg:col-span-1">
              <label className="filter-label">Search</label>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search task, assignee…"
                className="filter-input"
              />
            </div>
            <SearchableSelect label="Assignee" value={fAssignee} onChange={setFAssignee} options={lists.assignees} />
            <SearchableSelect label="Board / Project" value={fProject} onChange={setFProject} options={lists.projects} />
            <SearchableSelect label="Section" value={fSection} onChange={setFSection} options={lists.sections} />
            <Select label="Status" value={fStatus} onChange={setFStatus} options={["All", "Open", "Completed", "Overdue", "Archived"]} />
            <div className="col-span-2 md:col-span-1">
              <label className="filter-label">Calendar</label>
              <div className="flex flex-col gap-1.5 min-w-0">
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="filter-input min-w-0"
                  title="From date"
                />
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="filter-input min-w-0"
                  title="To date"
                />
              </div>
            </div>
          </div>
          <div className="flex justify-between items-center mt-3">
            <span className="text-xs text-gray-400">{loading ? "Loading…" : `${total.toLocaleString()} tasks match`}</span>
            <button onClick={resetFilters} className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline">
              Reset filters
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 mb-4 flex-wrap">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 rounded-full text-sm font-medium border transition ${tab === t
                  ? "bg-indigo-600 text-white border-indigo-600 shadow"
                  : "bg-white dark:bg-[#141414] border-gray-200 dark:border-gray-800 hover:border-indigo-400"
                }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Error / empty states */}
        {err && (
          <Panel>
            <p className="font-semibold text-red-600 dark:text-red-400 mb-1">
              {err.error === "NO_SUPABASE" ? "Supabase not connected" : "Could not load data"}
            </p>
            <p className="text-sm text-gray-500">{err.message || "Unknown error"}</p>
          </Panel>
        )}

        {!err && data && data.totalTasks === 0 && (
          <Panel>
            <p className="font-semibold text-amber-600 dark:text-amber-400 mb-1">No data yet</p>
            <p className="text-sm text-gray-500">
              Supabase is connected but empty. Run <code>npm run sync</code> once to pull your Asana workspace (~8 min).
            </p>
          </Panel>
        )}

        {!err && data && data.totalTasks > 0 && (
          <>
            {tab === "Overview" && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
                  <KPI label="Total Tasks" value={kpis.total} color="text-indigo-600 dark:text-indigo-400" />
                  <KPI label="Completed" value={kpis.completed} color="text-green-600 dark:text-green-400" />
                  <KPI label="Open" value={kpis.open} color="text-amber-600 dark:text-amber-400" />
                  <KPI label="Overdue" value={kpis.overdue} color="text-red-600 dark:text-red-400" />
                  <KPI label="Archived" value={kpis.archived} color="text-gray-500 dark:text-gray-400" />
                </div>
                <AssigneeTable rows={perAssignee} />
              </div>
            )}

            {tab === "Team" && (
              <div className="space-y-4">
                <PerAssigneeBar rows={perAssignee} dark={dark} />
                <AssigneeTable rows={perAssignee} />
              </div>
            )}

            {tab === "Tasks" && (
              <TaskTable
                tasks={tasks}
                today={today}
                page={page}
                pages={pages}
                total={total}
                onPage={setPage}
                onSelect={setDetailGid}
              />
            )}

            {tab === "Charts" && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <StatusDonut completed={kpis.completed} open={kpis.open - kpis.overdue} overdue={kpis.overdue} dark={dark} />
                <PerProjectBar rows={perProject} dark={dark} />
                <div className="lg:col-span-2">
                  <PerAssigneeBar rows={perAssignee} dark={dark} />
                </div>
              </div>
            )}

            {tab === "One Time Tasks" && <PerformanceTable data={performance} onSelect={setPerfPerson} />}

            {tab === "To-Do Tasks" && (
              <ToDoTasks daily={daily} recurring={recurring} person={todoPerson} onPerson={setTodoPerson} />
            )}

            {tab === "Planned vs Actual" && (
              <div className="space-y-4">
                <PlannedActualTable
                  data={planned}
                  from={plannedFrom}
                  to={plannedTo}
                  onFrom={setPlannedFrom}
                  onTo={setPlannedTo}
                />
                <PersonDetail
                  from={plannedFrom}
                  to={plannedTo}
                  people={planned && planned.rows ? planned.rows.map((r) => r.assignee) : []}
                />
              </div>
            )}

            {tab === "Activity" && <ActivityFeed data={activity} onSelect={setDetailGid} />}
          </>
        )}
      </div>

      <PerformancePersonDrawer
        person={perfPerson}
        tasks={perfTasks}
        onClose={() => {
          setPerfPerson(null);
          setPerfTasks(null);
        }}
        onSelectTask={(gid) => setDetailGid(gid)}
      />

      <TaskDetailDrawer
        open={!!detailGid}
        loading={detailLoading}
        detail={detail}
        onClose={() => {
          setDetailGid(null);
          setDetail(null);
        }}
      />

      <style jsx global>{`
        .btn-ghost {
          font-size: 0.8rem;
          padding: 0.4rem 0.7rem;
          border-radius: 0.6rem;
          border: 1px solid rgba(128, 128, 128, 0.25);
          display: inline-flex;
          align-items: center;
        }
        .btn-ghost:hover {
          border-color: #6366f1;
        }
        .btn-primary {
          font-size: 0.8rem;
          padding: 0.4rem 0.85rem;
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

function Select({ label, value, onChange, options }) {
  return (
    <div>
      <label className="filter-label">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="filter-input">
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

function SearchableSelect({ label, value, onChange, options }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef(null);

  useEffect(() => {
    function onDoc(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
        setQ("");
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return options;
    return options.filter((o) => String(o).toLowerCase().includes(s));
  }, [q, options]);

  const LIMIT = 200;

  return (
    <div className="relative" ref={ref}>
      <label className="filter-label">{label}</label>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="filter-input text-left flex items-center justify-between gap-1"
      >
        <span className="truncate">{value}</span>
        <span className="text-gray-400 text-xs">▾</span>
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-[#141414] shadow-xl">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Type to search…"
            className="w-full px-3 py-2 text-sm border-b border-gray-100 dark:border-gray-800 bg-transparent outline-none"
          />
          <ul className="max-h-60 overflow-y-auto py-1">
            {filtered.length === 0 && <li className="px-3 py-2 text-sm text-gray-400">No matches</li>}
            {filtered.slice(0, LIMIT).map((o) => (
              <li key={o}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(o);
                    setOpen(false);
                    setQ("");
                  }}
                  className={`w-full text-left px-3 py-1.5 text-sm hover:bg-indigo-50 dark:hover:bg-[#1a1a1a] truncate ${o === value ? "text-indigo-600 dark:text-indigo-400 font-semibold" : ""
                    }`}
                >
                  {o}
                </button>
              </li>
            ))}
            {filtered.length > LIMIT && (
              <li className="px-3 py-1.5 text-xs text-gray-400">
                +{filtered.length - LIMIT} more — keep typing to narrow…
              </li>
            )}
          </ul>
        </div>
      )}
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

function KPI({ label, value, color }) {
  return (
    <div className="bg-white dark:bg-[#141414] rounded-2xl border border-gray-200 dark:border-gray-800 p-5 shadow-sm">
      <p className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">{label}</p>
      <p className={`text-3xl font-bold mt-1 ${color}`}>{value.toLocaleString()}</p>
    </div>
  );
}

function pctBadge(pct) {
  if (pct >= 75) return "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400";
  if (pct >= 40) return "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400";
  return "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400";
}

// Score color: -100..-60 red, -60..-30 yellow, -30..0 green (green = mostly completed).
function scoreBadge(score) {
  if (score <= -60) return "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400";
  if (score <= -30) return "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400";
  return "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400";
}

function initials(name) {
  return (name || "?")
    .split(" ")
    .map((x) => x[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function AssigneeTable({ rows }) {
  return (
    <Panel>
      <p className="text-xs text-gray-400 mb-3">
        Per-person performance — <span className="font-semibold">One-Time tasks only</span> (Total, Completed, Pending,
        Overdue &amp; % are all one-time)
      </p>
      <div className="overflow-x-auto max-h-[70vh]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white dark:bg-[#141414]">
            <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200 dark:border-gray-800">
              <th className="py-2.5 px-2">Assignee</th>
              <th className="py-2.5 px-2">Total</th>
              <th className="py-2.5 px-2">Completed</th>
              <th className="py-2.5 px-2">Pending</th>
              <th className="py-2.5 px-2">Overdue</th>
              <th className="py-2.5 px-2">Completion</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-gray-400">
                  No data for the current filters.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.assignee} className="border-b border-gray-100 dark:border-gray-900 hover:bg-gray-50 dark:hover:bg-[#1a1a1a]">
                <td className="py-2.5 px-2">
                  <div className="flex items-center gap-2">
                    <span className="w-7 h-7 rounded-full bg-indigo-100 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-300 flex items-center justify-center text-xs font-semibold">
                      {initials(r.assignee)}
                    </span>
                    <span className="font-medium">{r.assignee}</span>
                  </div>
                </td>
                <td className="py-2.5 px-2">{r.total}</td>
                <td className="py-2.5 px-2 text-green-600 dark:text-green-400">{r.completed}</td>
                <td className="py-2.5 px-2 text-amber-600 dark:text-amber-400">{r.pending}</td>
                <td className="py-2.5 px-2 text-red-600 dark:text-red-400">{r.overdue}</td>
                <td className="py-2.5 px-2">
                  <span className={`inline-block px-2 py-1 rounded-md text-xs font-semibold ${pctBadge(r.pct)}`}>
                    {r.pct}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function PerformanceTable({ data, onSelect }) {
  const [q, setQ] = useState("");
  if (!data) return <Panel><p className="text-sm text-gray-500">Loading performance…</p></Panel>;
  if (data.error) {
    return (
      <Panel>
        <p className="font-semibold text-amber-600 dark:text-amber-400 mb-1">Performance not ready</p>
        <p className="text-sm text-gray-500">{data.message || "Run the performance SQL in Supabase."}</p>
      </Panel>
    );
  }
  const rows = data.rows || [];
  const s = q.trim().toLowerCase();
  const filtered = s ? rows.filter((r) => r.assignee.toLowerCase().includes(s)) : rows;
  return (
    <Panel>
      <h2 className="font-semibold text-sm mb-1">Performance scorecard — One-Time tasks</h2>
      <p className="text-xs text-gray-400 mb-3">
        Score = completion: <span className="font-semibold">0% = all tasks completed</span> (best, green),{" "}
        <span className="font-semibold">−100% = none completed</span> (worst, red). Worst first.
      </p>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search person…"
        className="filter-input mb-3 max-w-xs"
      />
      <div className="overflow-x-auto max-h-[75vh]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white dark:bg-[#141414]">
            <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200 dark:border-gray-800">
              <th className="py-2.5 px-2">Assignee</th>
              <th className="py-2.5 px-2">One-Time</th>
              <th className="py-2.5 px-2">Done</th>
              <th className="py-2.5 px-2">Pending</th>
              <th className="py-2.5 px-2">Overdue</th>
              <th className="py-2.5 px-2">On-time</th>
              <th className="py-2.5 px-2">Delayed</th>
              <th className="py-2.5 px-2">Revised</th>
              <th className="py-2.5 px-2">No due</th>
              <th className="py-2.5 px-2">Score</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={10} className="py-6 text-center text-gray-400">No matches.</td></tr>
            )}
            {filtered.map((r) => (
              <tr
                key={r.assignee}
                onClick={() => onSelect && onSelect(r)}
                className="border-b border-gray-100 dark:border-gray-900 hover:bg-indigo-50 dark:hover:bg-[#1a1a1a] cursor-pointer"
              >
                <td className="py-2.5 px-2 font-medium text-indigo-700 dark:text-indigo-300">{r.assignee}</td>
                <td className="py-2.5 px-2">{r.total}</td>
                <td className="py-2.5 px-2 text-green-600 dark:text-green-400">{r.completed}</td>
                <td className="py-2.5 px-2 text-amber-600 dark:text-amber-400">{r.pending}</td>
                <td className="py-2.5 px-2 text-red-600 dark:text-red-400">
                  {r.overdue}
                  {r.days_overdue ? <span className="text-xs text-gray-400"> · {r.days_overdue}d</span> : null}
                </td>
                <td className="py-2.5 px-2 text-green-600 dark:text-green-400">{r.on_time}</td>
                <td className="py-2.5 px-2 text-red-600 dark:text-red-400">
                  {r.delayed}
                  {r.days_late ? <span className="text-xs text-gray-400"> · {r.days_late}d</span> : null}
                </td>
                <td className="py-2.5 px-2 text-orange-600 dark:text-orange-400">{r.revised}</td>
                <td className="py-2.5 px-2 text-gray-400">{r.no_due}</td>
                <td className="py-2.5 px-2">
                  <span
                    className={`inline-block px-2 py-1 rounded-md text-xs font-semibold ${scoreBadge(r.score)}`}
                  >
                    {r.score}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ====================== To-Do Tasks (by person) ======================
// One searchable person picker; once a person is chosen, ALL their to-do
// cadences are shown stacked vertically — Daily → Weekly → Bi-Weekly →
// Monthly → Bi-Monthly → Quarterly — each with its own average score.
// Score = completed ÷ opportunities (recurring counts ON-TIME only).
const RECURRING_SECTIONS = [
  { kind: "weekly", title: "Weekly" },
  { kind: "biweekly", title: "Bi-Weekly" },
  { kind: "monthly", title: "Monthly" },
  { kind: "bimonthly", title: "Bi-Monthly" },
  { kind: "quarterly", title: "Quarterly" },
];

const istTodayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

// Daily completion across the week SO FAR: ticks ÷ (tasks × working days elapsed).
// (weekDates are already Mon–Sat, so Sundays are excluded.)
function dailyStats(daily, person) {
  if (!daily || daily.error) return null;
  const weekDates = daily.weekDates || [];
  const todayStr = istTodayStr();
  const tasks = (daily.rows || []).filter((r) => r.person === person);
  // Full week: every Mon–Sat day is an opportunity → denominator = tasks × 6.
  let done = 0;
  for (const t of tasks) {
    const set = new Set(t.dates || []);
    for (const d of weekDates) if (set.has(d)) done++;
  }
  const total = tasks.length * weekDates.length;
  const pct = total ? Math.round((100 * done) / total) : null;
  return { pct, done, total, tasks, weekDates, todayStr };
}

// Recurring completion across the WHOLE window: (on-time + late) ÷ cells that had a
// cycle due ('none' = no cycle that period, so it's not an opportunity).
function recurringStats(recurring, kind, person) {
  if (!recurring || recurring.error) return null;
  const data = (recurring && recurring[kind]) || { periods: [], rows: [] };
  const periods = data.periods || [];
  const tasks = (data.rows || []).filter((r) => r.person === person);
  // Full window: EVERY period shown is an opportunity → denominator = tasks ×
  // periods (including periods with no cycle due). Completed = on-time + late.
  let done = 0;
  let total = 0;
  for (const t of tasks) {
    if (!t.has_due) continue;
    total += periods.length;
    for (const v of t.cells || []) {
      if (v === "on_time" || v === "late") done++;
    }
  }
  const pct = total ? Math.round((100 * done) / total) : null;
  return { pct, done, total, tasks, periods };
}

function ToDoTasks({ daily, recurring, person, onPerson }) {
  // union of every person across the daily roster + all recurring cadences
  const people = useMemo(() => {
    const set = new Set();
    (daily && daily.rows ? daily.rows : []).forEach((r) => r.person && set.add(r.person));
    RECURRING_SECTIONS.forEach(({ kind }) =>
      ((recurring && recurring[kind] && recurring[kind].rows) || []).forEach((r) => r.person && set.add(r.person))
    );
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [daily, recurring]);

  const loading = !daily || !recurring;

  // Total Average Completion = simple average of the per-section %s the person
  // actually has (empty sections don't drag it down).
  const sectionPcts = [];
  if (person) {
    const d = dailyStats(daily, person);
    if (d && d.pct != null) sectionPcts.push(d.pct);
    for (const { kind } of RECURRING_SECTIONS) {
      const r = recurringStats(recurring, kind, person);
      if (r && r.pct != null) sectionPcts.push(r.pct);
    }
  }
  const totalAvg = sectionPcts.length
    ? Math.round(sectionPcts.reduce((a, b) => a + b, 0) / sectionPcts.length)
    : null;

  return (
    <Panel>
      <h2 className="font-semibold text-sm mb-1">To-Do scorecard by person</h2>
      <p className="text-xs text-gray-400 mb-3">
        Pick a person to see all their to-do cadences in one place. Each section's{" "}
        <span className="font-semibold">average = completed ÷ opportunities</span> across the whole window shown
        (late still counts as done). The badge at the <span className="font-semibold">top-right</span> is their{" "}
        <span className="font-semibold">total average completion</span> across all sections.
      </p>

      <div className="flex items-end gap-2 mb-4">
        <div className="w-full max-w-xs">
          <SearchableSelect label="Person" value={person || "— Select a person —"} onChange={onPerson} options={people} />
        </div>
        {person && (
          <button onClick={() => onPerson(null)} className="btn-ghost" title="Clear and pick another person">
            ✕ Clear
          </button>
        )}
      </div>

      {loading && <p className="text-sm text-gray-500">Loading scorecards…</p>}

      {!loading && !person && (
        <p className="py-8 text-center text-gray-400 text-sm">
          Search and select a person above to view their daily → quarterly scorecard.
        </p>
      )}

      {!loading && person && (
        <div className="space-y-6 max-h-[78vh] overflow-y-auto pr-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="w-9 h-9 rounded-full bg-indigo-100 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-300 flex items-center justify-center text-sm font-semibold">
                {initials(person)}
              </span>
              <span className="font-semibold text-base">{person}</span>
            </div>
            {totalAvg != null && (
              <span
                className={`inline-flex items-baseline gap-2 px-4 py-2 rounded-xl text-lg font-bold shadow-sm ${scoreBadge(totalAvg - 100)}`}
                title="Average of all this person's to-do section scores (0 = all done, −100 = none)"
              >
                {totalAvg - 100}% <span className="text-xs font-semibold opacity-75">total avg score</span>
              </span>
            )}
          </div>

          <DailyPersonSection daily={daily} person={person} />
          {RECURRING_SECTIONS.map(({ kind, title }) => (
            <RecurringPersonSection key={kind} kind={kind} title={title} recurring={recurring} person={person} />
          ))}
        </div>
      )}
    </Panel>
  );
}

// Shared shell: section title + average-score badge + task count, then a table.
function SectionShell({ title, avg, count, done, total, note, children }) {
  return (
    <div className="border-t border-gray-100 dark:border-gray-900 pt-4">
      <div className="flex flex-wrap items-center gap-3 mb-1">
        <h3 className="font-semibold text-base">{title}</h3>
        {avg != null ? (
          <span
            className={`inline-flex items-baseline gap-2 px-4 py-2 rounded-xl text-lg font-bold shadow-sm ${scoreBadge(avg - 100)}`}
          >
            {avg - 100}% score
            {total ? <span className="text-sm font-semibold opacity-75">· {done} of {total} done</span> : null}
          </span>
        ) : (
          <span className="text-sm text-gray-400">no score</span>
        )}
        <span className="text-xs text-gray-400">
          {count} task{count === 1 ? "" : "s"}
        </span>
      </div>
      {note && <p className="text-base text-gray-400 italic mb-3">📅 {note}</p>}
      {!note && <div className="mb-3" />}
      {children}
    </div>
  );
}

function DailyPersonSection({ daily, person }) {
  if (daily && daily.error) {
    return (
      <SectionShell title="Daily" avg={null} count={0}>
        <p className="text-xs text-amber-600 dark:text-amber-400">{daily.message || "Daily tracker not ready."}</p>
      </SectionShell>
    );
  }
  const st = dailyStats(daily, person) || { pct: null, done: 0, total: 0, tasks: [], weekDates: [], todayStr: istTodayStr() };
  const { tasks, weekDates, todayStr } = st;
  const wd = (d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(d + "T00:00:00Z").getUTCDay()];
  const windowNote = weekDates.length
    ? `Completion ${weekDates[0]} → ${weekDates[weekDates.length - 1]}`
    : "Completion this week so far (Mon–Sat)";

  const cell = (date, done) => {
    if (done) return "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400";
    if (date < todayStr) return "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400";
    return "bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-600";
  };

  return (
    <SectionShell title="Daily" avg={st.pct} count={tasks.length} done={st.done} total={st.total} note={windowNote}>
      {tasks.length === 0 ? (
        <p className="text-xs text-gray-400">No daily tasks.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-gray-400 border-b border-gray-200 dark:border-gray-800">
                <th className="py-1.5 px-2">Daily task</th>
                {weekDates.map((d) => (
                  <th key={d} className="py-1.5 px-1 text-center w-10" title={d}>
                    {wd(d)}
                  </th>
                ))}
                <th className="py-1.5 px-2 text-center">Done</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => {
                const dates = t.dates || [];
                return (
                  <tr key={t.task_gid} className="border-b border-gray-100 dark:border-gray-900">
                    <td className="py-1.5 px-2">{t.task}</td>
                    {weekDates.map((d) => {
                      const done = dates.includes(d);
                      return (
                        <td key={d} className="py-1.5 px-1 text-center">
                          <span
                            className={`inline-flex items-center justify-center w-6 h-6 rounded-md text-xs font-bold ${cell(d, done)}`}
                            title={d}
                          >
                            {done ? "✓" : d < todayStr ? "✗" : "·"}
                          </span>
                        </td>
                      );
                    })}
                    <td className="py-1.5 px-2 text-center">
                      <span
                        className={`inline-block px-2 py-1 rounded-md text-xs font-semibold ${t.done >= weekDates.length ? pctBadge(100) : t.done >= weekDates.length / 2 ? pctBadge(60) : pctBadge(0)
                          }`}
                      >
                        {t.done}/{weekDates.length}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionShell>
  );
}

function RecurringPersonSection({ kind, title, recurring, person }) {
  if (recurring && recurring.error) {
    return (
      <SectionShell title={title} avg={null} count={0}>
        <p className="text-xs text-amber-600 dark:text-amber-400">{recurring.message || "Recurring tracker not ready."}</p>
      </SectionShell>
    );
  }
  const st = recurringStats(recurring, kind, person) || { pct: null, done: 0, total: 0, tasks: [], periods: [] };
  const { tasks, periods } = st;

  const cellCls = (v) =>
    v === "on_time"
      ? "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400"
      : v === "late"
        ? "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400"
        : v === "missed"
          ? "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400"
          : "bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-600";
  const glyph = (v) => (v === "on_time" ? "✓" : v === "late" ? "✓" : v === "missed" ? "✗" : "·");

  return (
    <SectionShell title={title} avg={st.pct} count={tasks.length} done={st.done} total={st.total} note={`Completion across ${periods.length} ${title.toLowerCase()} period${periods.length === 1 ? "" : "s"} shown · late counts as done`}>
      {tasks.length === 0 ? (
        <p className="text-xs text-gray-400">No {title.toLowerCase()} tasks.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-gray-400 border-b border-gray-200 dark:border-gray-800">
                <th className="py-1.5 px-2">Task</th>
                {periods.map((p) => (
                  <th key={p} className="py-1.5 px-1 text-center w-14">
                    {p}
                  </th>
                ))}
                <th className="py-1.5 px-2 text-center">Done</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.task_gid} className="border-b border-gray-100 dark:border-gray-900">
                  <td className="py-1.5 px-2">
                    {t.task}
                    {!t.has_due && (
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                        no due date
                      </span>
                    )}
                  </td>
                  {t.has_due ? (
                    t.cells.map((v, i) => (
                      <td key={i} className="py-1.5 px-1 text-center">
                        <span
                          className={`inline-flex items-center justify-center w-6 h-6 rounded-md text-xs font-bold ${cellCls(v)}`}
                          title={periods[i]}
                        >
                          {glyph(v)}
                        </span>
                      </td>
                    ))
                  ) : (
                    <td className="py-1.5 px-1 text-center text-gray-400" colSpan={periods.length}>
                      —
                    </td>
                  )}
                  <td className="py-1.5 px-2 text-center">
                    {t.has_due ? (
                      <span
                        className={`inline-block px-2 py-1 rounded-md text-xs font-semibold ${t.done >= periods.length
                            ? pctBadge(100)
                            : t.done >= Math.ceil(periods.length / 2)
                              ? pctBadge(60)
                              : pctBadge(0)
                          }`}
                      >
                        {t.done}/{periods.length}
                      </span>
                    ) : (
                      <span className="text-gray-400 text-xs">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionShell>
  );
}

function daysBetween(a, b) {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

function classifyTask(t, today) {
  if (t.completed) {
    if (!t.due_on || !t.completed_at) return { label: "No due date", cls: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300", days: "" };
    const cd = t.completed_at.slice(0, 10);
    if (cd <= t.due_on) return { label: "On-time", cls: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400", days: "" };
    return { label: "Delayed", cls: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400", days: `+${daysBetween(t.due_on, cd)}d` };
  }
  if (t.due_on && t.due_on < today) {
    return { label: "Overdue", cls: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400", days: `${daysBetween(t.due_on, today)}d` };
  }
  return { label: "Pending", cls: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400", days: "" };
}

function PerformancePersonDrawer({ person, tasks, onClose, onSelectTask }) {
  const [collapsed, setCollapsed] = useState({});
  useEffect(() => {
    setCollapsed({});
  }, [person ? person.assignee : null]);
  if (!person) return null;
  const today = new Date().toISOString().slice(0, 10);
  // group tasks by their Asana section
  const groups = {};
  (tasks || []).forEach((t) => {
    // exact section from the person's one-time board; fall back if not synced yet
    const sec = t.one_time_section || (t.sections && t.sections[0]) || t.section || "No section";
    (groups[sec] = groups[sec] || []).push(t);
  });
  const sectionNames = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-2xl h-full bg-white dark:bg-[#141414] shadow-2xl overflow-y-auto">
        <div className="sticky top-0 bg-white dark:bg-[#141414] border-b border-gray-200 dark:border-gray-800 px-5 py-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide">Performance · One-Time tasks</p>
            <h2 className="font-bold text-base">{person.assignee}</h2>
            <div className="flex flex-wrap gap-2 mt-2 text-xs">
              <span className={`px-2 py-1 rounded-md font-semibold ${scoreBadge(person.score)}`}>
                Score {person.score}%
              </span>
              <span className="text-gray-500">Total {person.total}</span>
              <span className="text-green-600 dark:text-green-400">On-time {person.on_time}</span>
              <span className="text-red-600 dark:text-red-400">Delayed {person.delayed}</span>
              <span className="text-red-600 dark:text-red-400">Overdue {person.overdue}</span>
              <span className="text-orange-600 dark:text-orange-400">Revised {person.revised}</span>
              <span className="text-gray-400">No due {person.no_due}</span>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-xl leading-none">✕</button>
        </div>

        {!tasks && <p className="p-5 text-sm text-gray-500">Loading tasks…</p>}
        {tasks && tasks.length === 0 && <p className="p-5 text-sm text-gray-400">No one-time tasks.</p>}
        {tasks && tasks.length > 0 && (
          <div className="p-3">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200 dark:border-gray-800">
                  <th className="py-2 px-2">Task</th>
                  <th className="py-2 px-2">Added</th>
                  <th className="py-2 px-2">Due</th>
                  <th className="py-2 px-2">Completed</th>
                  <th className="py-2 px-2">Status</th>
                  <th className="py-2 px-2">Revised</th>
                </tr>
              </thead>
              <tbody>
                {sectionNames.map((sec) => (
                  <Fragment key={sec}>
                    <tr
                      className="bg-gray-50 dark:bg-[#0f0f0f] cursor-pointer select-none"
                      onClick={() => setCollapsed((c) => ({ ...c, [sec]: !c[sec] }))}
                    >
                      <td colSpan={6} className="py-2 px-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                        <span className="inline-block w-3 text-gray-400">{collapsed[sec] ? "▸" : "▾"}</span> {sec}{" "}
                        <span className="text-gray-400">({groups[sec].length})</span>
                      </td>
                    </tr>
                    {!collapsed[sec] &&
                      groups[sec].map((t) => {
                        const c = classifyTask(t, today);
                        const revised =
                          t.original_due_on && t.due_on && Math.abs(daysBetween(t.original_due_on, t.due_on)) > 7;
                        return (
                          <tr
                            key={t.gid}
                            onClick={() => onSelectTask && onSelectTask(t.gid)}
                            className="border-b border-gray-100 dark:border-gray-900 hover:bg-indigo-50 dark:hover:bg-[#1a1a1a] cursor-pointer"
                          >
                            <td className="py-2 px-2 max-w-xs truncate" title={t.name}>{t.name}</td>
                            <td className="py-2 px-2 text-gray-500">{t.created_at ? t.created_at.slice(0, 10) : "—"}</td>
                            <td className="py-2 px-2 text-gray-500">{t.due_on || "—"}</td>
                            <td className="py-2 px-2 text-gray-500">{t.completed_at ? t.completed_at.slice(0, 10) : "—"}</td>
                            <td className="py-2 px-2">
                              <span className={`inline-block px-2 py-0.5 rounded-md text-xs font-semibold ${c.cls}`}>{c.label}</span>
                              {c.days && <span className="ml-1.5 text-xs text-gray-400">{c.days}</span>}
                            </td>
                            <td className="py-2 px-2">
                              {revised ? (
                                <span className="px-2 py-0.5 rounded-md text-xs font-semibold bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400">🔁 Revised</span>
                              ) : (
                                <span className="text-gray-300 dark:text-gray-700">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function PlannedActualTable({ data, from, to, onFrom, onTo }) {
  const [q, setQ] = useState("");
  const rows = (data && data.rows) || [];
  const s = q.trim().toLowerCase();
  const filtered = s ? rows.filter((r) => r.assignee.toLowerCase().includes(s)) : rows;
  const totals = filtered.reduce(
    (a, r) => ({
      total: a.total + (r.total || 0),
      unplanned: a.unplanned + (r.unplanned || 0),
      planned: a.planned + r.planned,
      on_time: a.on_time + r.on_time,
      late: a.late + r.late,
      delay: a.delay + (r.delay_over_1week || 0),
      not_done: a.not_done + r.not_done,
    }),
    { total: 0, unplanned: 0, planned: 0, on_time: 0, late: 0, delay: 0, not_done: 0 }
  );

  return (
    <Panel>
      <h2 className="font-semibold text-sm mb-1">Planned vs Actual — One-Time tasks</h2>
      <p className="text-xs text-gray-400 mb-3">
        <span className="font-semibold">Planned</span> = one-time tasks whose <span className="font-semibold">Planned End Date</span>{" "}
        falls in the range below (empty = all time). <span className="font-semibold">Actual</span> = the task&apos;s{" "}
        <span className="font-semibold">Actual End Date</span>. Done <span className="font-semibold">within 1 week</span> of planned
        counts (on-time or ≤7 days late); <span className="font-semibold">more than 1 week late</span> is neutral (not scored) and
        shown under <span className="font-semibold">Delay &gt;1wk</span>. The date range applies to{" "}
        <span className="font-semibold">Planned</span> (and the scored columns) by <span className="font-semibold">Planned End Date</span>,
        and to <span className="font-semibold">Unplanned</span> (no Planned End Date set) by{" "}
        <span className="font-semibold">task-created date</span>. <span className="font-semibold">Total</span> = Planned + Unplanned.
        Score: 0% = all on time · −100% = none · — = nothing scorable. Worst first.
      </p>

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div>
          <label className="filter-label">Planned end date from</label>
          <input type="date" value={from} onChange={(e) => onFrom(e.target.value)} className="filter-input" />
        </div>
        <div>
          <label className="filter-label">Planned end date to</label>
          <input type="date" value={to} onChange={(e) => onTo(e.target.value)} className="filter-input" />
        </div>
        <button
          type="button"
          onClick={() => {
            onFrom("");
            onTo("");
          }}
          disabled={!from && !to}
          className="btn-ghost disabled:opacity-40 disabled:cursor-not-allowed"
          title="Clear the date range (show all time)"
        >
          ✕ Clear
        </button>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search person…"
          className="filter-input max-w-xs ml-auto"
        />
      </div>

      {!data && <p className="text-sm text-gray-500">Loading planned vs actual…</p>}
      {data && data.error && (
        <p className="text-sm text-amber-600 dark:text-amber-400">{data.message || "Run the SQL in Supabase, then reload."}</p>
      )}

      {data && !data.error && (
        <>
          <p className="text-xs text-gray-400 mb-2">
            {filtered.length} people · total {totals.total.toLocaleString()} · planned {totals.planned.toLocaleString()} ·
            unplanned {totals.unplanned.toLocaleString()} · on-time {totals.on_time.toLocaleString()} · late{" "}
            {totals.late.toLocaleString()} · delay &gt;1wk {totals.delay.toLocaleString()} · not done{" "}
            {totals.not_done.toLocaleString()}
          </p>
          <div className="overflow-x-auto max-h-[70vh]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white dark:bg-[#141414]">
                <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200 dark:border-gray-800">
                  <th className="py-2.5 px-2">Assignee</th>
                  <th className="py-2.5 px-2">Total</th>
                  <th className="py-2.5 px-2">Planned</th>
                  <th className="py-2.5 px-2">Unplanned</th>
                  <th className="py-2.5 px-2">On-Time</th>
                  <th className="py-2.5 px-2">Late (≤1wk)</th>
                  <th className="py-2.5 px-2">Delay &gt;1wk</th>
                  <th className="py-2.5 px-2">Not Done</th>
                  <th className="py-2.5 px-2">Score</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={9} className="py-6 text-center text-gray-400">
                      No one-time tasks in this range.
                    </td>
                  </tr>
                )}
                {filtered.map((r) => (
                  <tr key={r.assignee} className="border-b border-gray-100 dark:border-gray-900 hover:bg-gray-50 dark:hover:bg-[#1a1a1a]">
                    <td className="py-2.5 px-2 font-medium">{r.assignee}</td>
                    <td className="py-2.5 px-2 font-semibold">{r.total ?? 0}</td>
                    <td className="py-2.5 px-2">{r.planned}</td>
                    <td className="py-2.5 px-2 text-gray-500 dark:text-gray-400">{r.unplanned ?? 0}</td>
                    <td className="py-2.5 px-2 text-green-600 dark:text-green-400">{r.on_time}</td>
                    <td className="py-2.5 px-2 text-red-600 dark:text-red-400">{r.late}</td>
                    <td className="py-2.5 px-2 text-orange-600 dark:text-orange-400">{r.delay_over_1week ?? 0}</td>
                    <td className="py-2.5 px-2 text-amber-600 dark:text-amber-400">{r.not_done}</td>
                    <td className="py-2.5 px-2">
                      {r.score == null ? (
                        <span className="inline-block px-2 py-1 rounded-md text-xs font-semibold bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                          —
                        </span>
                      ) : (
                        <span className={`inline-block px-2 py-1 rounded-md text-xs font-semibold ${scoreBadge(r.score)}`}>
                          {r.score}%
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}

// Per-person detail — shows the SELECTED person's one-time tasks by Planned End Date.
// Date range + people list come from the parent (the always-on aggregate table above).
function PersonDetail({ from, to, people }) {
  const [person, setPerson] = useState("");
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!person) { setData(null); return; }
    let cancelled = false;
    setData(null);
    const p = new URLSearchParams({ assignee: person });
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    fetch(`/api/planned/person?${p.toString()}`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setData(j); })
      .catch((e) => { if (!cancelled) setData({ error: "DB_ERROR", message: String(e) }); });
    return () => { cancelled = true; };
  }, [person, from, to]);

  const opts = ["— Select a person —", ...(people || [])];
  const cls = (c) =>
    c === "green"
      ? "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400"
      : c === "yellow"
        ? "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400"
        : c === "red"
          ? "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400"
          : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400";
  const label = (c) =>
    c === "green" ? "🟢 On-time / early" : c === "yellow" ? "🟡 Late 1–6d" : c === "red" ? "🔴 Late 7d+" : "⚪ Pending";
  const rows = (data && data.rows) || [];

  return (
    <Panel>
      <h2 className="font-semibold text-sm mb-1">Individual breakdown — by Planned End Date</h2>
      <p className="text-xs text-gray-400 mb-3">
        Pick a person to see their one-time tasks (Planned End Date in the range above).
        Color = Actual vs Planned end date · 🟢 on-time/early · 🟡 1–6d late · 🔴 7d+ late · ⚪ not done yet.
      </p>
      <div className="max-w-xs mb-4">
        <SearchableSelect
          label="Person"
          value={person || "— Select a person —"}
          onChange={(v) => setPerson(v === "— Select a person —" ? "" : v)}
          options={opts}
        />
      </div>

      {!person && (
        <p className="py-8 text-center text-gray-400 text-sm">Select a person above to see their Planned vs Actual.</p>
      )}
      {person && !data && <p className="text-sm text-gray-500">Loading…</p>}
      {person && data && data.error && (
        <p className="text-sm text-amber-600 dark:text-amber-400">{data.message || "Error loading data."}</p>
      )}
      {person && data && !data.error && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
            <div className="flex items-center gap-2">
              <span className="w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-300 flex items-center justify-center text-xs font-semibold">
                {initials(person)}
              </span>
              <span className="font-semibold text-sm">{person}</span>
            </div>
            {data.score != null && (
              <span className={`inline-flex items-baseline gap-2 px-4 py-2 rounded-xl text-lg font-bold shadow-sm ${scoreBadge(data.score)}`}>
                {data.score}% <span className="text-xs font-semibold opacity-75">{data.done}/{data.planned} completed</span>
              </span>
            )}
          </div>
          <div className="overflow-x-auto max-h-[68vh]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white dark:bg-[#141414]">
                <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200 dark:border-gray-800">
                  <th className="py-2.5 px-2">Task</th>
                  <th className="py-2.5 px-2">Planned End</th>
                  <th className="py-2.5 px-2">Actual End</th>
                  <th className="py-2.5 px-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-gray-400">
                      No one-time tasks with a Planned End Date in this range.
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr key={r.gid} className="border-b border-gray-100 dark:border-gray-900">
                    <td className="py-2 px-2 max-w-md truncate" title={r.name}>{r.name}</td>
                    <td className="py-2 px-2 text-gray-500">{r.planned_end_date || "—"}</td>
                    <td className="py-2 px-2 text-gray-500">{r.actual_end_date || "—"}</td>
                    <td className="py-2 px-2">
                      <span className={`inline-block px-2 py-1 rounded-md text-xs font-semibold ${cls(r.color)}`}>{label(r.color)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}

// TEST panel: Arjun's one-time tasks scored by Planned vs Actual end date.
function ArjunPlannedActual({ data }) {
  if (!data) return <Panel><p className="text-sm text-gray-500">Loading Arjun planned-vs-actual…</p></Panel>;
  if (data.error) {
    return (
      <Panel>
        <p className="font-semibold text-amber-600 dark:text-amber-400 mb-1">Arjun test not ready</p>
        <p className="text-sm text-gray-500">{data.message || "Run the ALTER TABLE SQL, then sync."}</p>
      </Panel>
    );
  }
  const rows = data.rows || [];
  const cls = (c) =>
    c === "green"
      ? "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400"
      : c === "yellow"
        ? "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400"
        : c === "red"
          ? "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400"
          : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400";
  const label = (c) =>
    c === "green" ? "🟢 On-time / early" : c === "yellow" ? "🟡 Late 1–6d" : c === "red" ? "🔴 Late 7d+" : "⚪ Pending";
  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h2 className="font-semibold text-sm">Arjun — Planned vs Actual (TEST) · by Planned End Date</h2>
        {data.score != null && (
          <span className={`inline-flex items-baseline gap-2 px-4 py-2 rounded-xl text-lg font-bold shadow-sm ${scoreBadge(data.score)}`}>
            {data.score}% <span className="text-xs font-semibold opacity-75">{data.done}/{data.planned} completed</span>
          </span>
        )}
      </div>
      <p className="text-xs text-gray-400 mb-3">
        Arjun's one-time tasks whose <span className="font-semibold">Planned End Date</span> is in the range above.
        Color = Actual vs Planned end date · 🟢 on-time/early · 🟡 1–6d late · 🔴 7d+ late · ⚪ not done yet.
      </p>
      <div className="overflow-x-auto max-h-[70vh]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white dark:bg-[#141414]">
            <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200 dark:border-gray-800">
              <th className="py-2.5 px-2">Task</th>
              <th className="py-2.5 px-2">Planned End</th>
              <th className="py-2.5 px-2">Actual End</th>
              <th className="py-2.5 px-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-gray-400">
                  No Arjun one-time tasks with a Planned End Date in this range.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.gid} className="border-b border-gray-100 dark:border-gray-900">
                <td className="py-2 px-2 max-w-md truncate" title={r.name}>{r.name}</td>
                <td className="py-2 px-2 text-gray-500">{r.planned_end_date || "—"}</td>
                <td className="py-2 px-2 text-gray-500">{r.actual_end_date || "—"}</td>
                <td className="py-2 px-2">
                  <span className={`inline-block px-2 py-1 rounded-md text-xs font-semibold ${cls(r.color)}`}>{label(r.color)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ActivityFeed({ data, onSelect }) {
  if (!data) {
    return <Panel><p className="text-sm text-gray-500">Loading activity…</p></Panel>;
  }
  const fmt = (d) => (d ? new Date(d).toLocaleString() : "—");

  const Item = ({ t, date, onClick }) => (
    <li
      onClick={onClick}
      className={`py-2.5 border-b border-gray-100 dark:border-gray-900 last:border-0 ${onClick ? "cursor-pointer hover:bg-indigo-50 dark:hover:bg-[#1a1a1a] -mx-2 px-2 rounded" : ""
        }`}
    >
      <p className="font-medium text-sm truncate" title={t.name}>{t.name}</p>
      <p className="text-xs text-gray-400 mt-0.5">
        {t.assignee || "Unassigned"} • {(t.projects && t.projects[0]) || t.project || "—"} • {date}
      </p>
    </li>
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Panel>
        <h3 className="font-semibold text-sm mb-1">🟢 Recently Added</h3>
        <p className="text-xs text-gray-400 mb-2">Newest tasks created in Asana</p>
        <ul>
          {data.added.length === 0 && <li className="text-sm text-gray-400 py-2">Nothing yet.</li>}
          {data.added.map((t) => (
            <Item key={t.gid} t={t} date={fmt(t.created_at)} onClick={() => onSelect(t.gid)} />
          ))}
        </ul>
      </Panel>

      <Panel>
        <h3 className="font-semibold text-sm mb-1">✅ Recently Completed</h3>
        <p className="text-xs text-gray-400 mb-2">Tasks marked done</p>
        <ul>
          {data.completed.length === 0 && <li className="text-sm text-gray-400 py-2">Nothing yet.</li>}
          {data.completed.map((t) => (
            <Item key={t.gid} t={t} date={fmt(t.completed_at)} onClick={() => onSelect(t.gid)} />
          ))}
        </ul>
      </Panel>

      <Panel>
        <h3 className="font-semibold text-sm mb-1">🔴 Recently Removed</h3>
        <p className="text-xs text-gray-400 mb-2">Tasks deleted from Asana</p>
        <ul>
          {data.removed.length === 0 && (
            <li className="text-sm text-gray-400 py-2">
              {data.removedError ? "Run the mis_changes SQL to enable this." : "No removals recorded yet."}
            </li>
          )}
          {data.removed.map((t, i) => (
            <Item key={t.gid + "-" + i} t={t} date={fmt(t.at)} />
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function TaskDetailDrawer({ open, loading, detail, onClose }) {
  if (!open) return null;
  const t = detail && detail.task;
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-lg h-full bg-white dark:bg-[#141414] shadow-2xl overflow-y-auto">
        <div className="sticky top-0 bg-white dark:bg-[#141414] border-b border-gray-200 dark:border-gray-800 px-5 py-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-gray-400 uppercase tracking-wide">Task detail</p>
            <h2 className="font-bold text-base leading-snug break-words">
              {loading ? "Loading…" : t ? t.name : "Could not load"}
            </h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-xl leading-none">
            ✕
          </button>
        </div>

        {loading && <p className="p-5 text-sm text-gray-500">Fetching live from Asana…</p>}

        {!loading && detail && detail.error && (
          <p className="p-5 text-sm text-red-500">Couldn’t load this task.</p>
        )}

        {!loading && t && (
          <div className="p-5 space-y-5 text-sm">
            <div className="flex flex-wrap gap-2">
              <span
                className={`px-2 py-1 rounded-md text-xs font-semibold ${t.completed
                    ? "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400"
                    : "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400"
                  }`}
              >
                {t.completed ? "Completed" : "Open"}
              </span>
              {t.permalink && (
                <a
                  href={t.permalink}
                  target="_blank"
                  rel="noreferrer"
                  className="px-2 py-1 rounded-md text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700"
                >
                  Open in Asana ↗
                </a>
              )}
            </div>

            <dl className="grid grid-cols-3 gap-y-2 gap-x-2">
              <Meta label="Assignee" value={t.assignee} />
              <Meta label="Due date" value={t.due_on || "—"} />
              <Meta label="Projects" value={t.projects.join(", ") || "—"} />
              <Meta label="Sections" value={t.sections.join(", ") || "—"} />
              {t.tags.length > 0 && <Meta label="Tags" value={t.tags.join(", ")} />}
              {t.customFields.map((c) => (
                <Meta key={c.name} label={c.name} value={c.value} />
              ))}
            </dl>

            {t.notes && (
              <Section title="Description">
                <p className="whitespace-pre-wrap text-gray-700 dark:text-gray-300">{t.notes}</p>
              </Section>
            )}

            <Section title={`Subtasks (${detail.subtasks.length})`}>
              {detail.subtasks.length === 0 ? (
                <p className="text-gray-400">No subtasks.</p>
              ) : (
                <ul className="space-y-1.5">
                  {detail.subtasks.map((s) => {
                    const revised =
                      s.original_due_on && s.due_on && Math.abs(daysBetween(s.original_due_on, s.due_on)) > 7;
                    return (
                      <li key={s.gid} className="flex items-center gap-2 flex-wrap">
                        <span className={s.completed ? "text-green-500" : "text-gray-400"}>{s.completed ? "☑" : "☐"}</span>
                        <span className={s.completed ? "line-through text-gray-400" : ""}>{s.name}</span>
                        {s.due_on && <span className="text-xs text-gray-500">· due {s.due_on}</span>}
                        {revised && (
                          <span
                            className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400"
                            title={`Original due ${s.original_due_on}, now ${s.due_on}`}
                          >
                            🔁 Revised (was {s.original_due_on} → now {s.due_on})
                          </span>
                        )}
                        <span className="text-xs text-gray-400 ml-auto">{s.assignee}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Section>

            <Section title={`Comments (${detail.comments.length})`}>
              {detail.comments.length === 0 ? (
                <p className="text-gray-400">No comments.</p>
              ) : (
                <ul className="space-y-3">
                  {detail.comments.map((c) => (
                    <li key={c.gid} className="border-l-2 border-gray-200 dark:border-gray-800 pl-3">
                      <p className="text-xs text-gray-400">
                        {c.author} • {c.created_at ? new Date(c.created_at).toLocaleString() : ""}
                      </p>
                      <p className="whitespace-pre-wrap text-gray-700 dark:text-gray-300">{c.text}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title={`Attachments (${detail.attachments.length})`}>
              {detail.attachments.length === 0 ? (
                <p className="text-gray-400">No attachments.</p>
              ) : (
                <ul className="space-y-1.5">
                  {detail.attachments.map((a) => (
                    <li key={a.gid}>
                      {a.url ? (
                        <a href={a.url} target="_blank" rel="noreferrer" className="text-indigo-600 dark:text-indigo-400 hover:underline">
                          📎 {a.name}
                        </a>
                      ) : (
                        <span>📎 {a.name}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}

function Meta({ label, value }) {
  return (
    <>
      <dt className="col-span-1 text-gray-400">{label}</dt>
      <dd className="col-span-2 font-medium break-words">{value}</dd>
    </>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2 border-t border-gray-100 dark:border-gray-900 pt-3">
        {title}
      </h3>
      {children}
    </div>
  );
}

function TaskTable({ tasks, today, page, pages, total, onPage, onSelect }) {
  return (
    <Panel>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-gray-400">{total.toLocaleString()} tasks</p>
        <div className="flex items-center gap-2 text-sm">
          <button onClick={() => onPage(Math.max(1, page - 1))} disabled={page <= 1} className="btn-ghost">
            ‹ Prev
          </button>
          <span className="text-xs text-gray-500">
            Page {page} / {pages}
          </span>
          <button onClick={() => onPage(Math.min(pages, page + 1))} disabled={page >= pages} className="btn-ghost">
            Next ›
          </button>
        </div>
      </div>
      <div className="overflow-x-auto max-h-[70vh]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white dark:bg-[#141414]">
            <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200 dark:border-gray-800">
              <th className="py-2.5 px-2">Task</th>
              <th className="py-2.5 px-2">Assignee</th>
              <th className="py-2.5 px-2">Project</th>
              <th className="py-2.5 px-2">Section</th>
              <th className="py-2.5 px-2">Due</th>
              <th className="py-2.5 px-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-gray-400">
                  No tasks match the current filters.
                </td>
              </tr>
            )}
            {tasks.map((t) => {
              const overdue = !t.completed && t.due_on && t.due_on < today;
              const status = t.completed ? "Completed" : overdue ? "Overdue" : "Open";
              const cls = t.completed
                ? "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400"
                : overdue
                  ? "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400"
                  : "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400";
              return (
                <tr
                  key={t.gid}
                  onClick={() => onSelect && onSelect(t.gid)}
                  className="border-b border-gray-100 dark:border-gray-900 hover:bg-indigo-50 dark:hover:bg-[#1a1a1a] cursor-pointer"
                >
                  <td className="py-2.5 px-2 max-w-xs truncate font-medium text-indigo-700 dark:text-indigo-300" title={t.name}>{t.name}</td>
                  <td className="py-2.5 px-2">{t.assignee}</td>
                  <td className="py-2.5 px-2 text-gray-500">
                    {(() => {
                      const ps = t.projects && t.projects.length ? t.projects : t.project ? [t.project] : [];
                      const title = ps.join(", ");
                      return (
                        <span title={title}>
                          {ps[0] || "—"}
                          {ps.length > 1 && (
                            <span className="ml-1 px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300 text-[10px] font-semibold">
                              +{ps.length - 1}
                            </span>
                          )}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="py-2.5 px-2 text-gray-500">
                    {(t.sections && t.sections.length ? t.sections : t.section ? [t.section] : []).join(", ") || "—"}
                  </td>
                  <td className="py-2.5 px-2 text-gray-500">{t.due_on || "—"}</td>
                  <td className="py-2.5 px-2">
                    <span className={`inline-block px-2 py-1 rounded-md text-xs font-semibold ${cls}`}>{status}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
