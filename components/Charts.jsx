"use client";

import { useState, useMemo } from "react";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";

const STATUS_COLORS = {
  Completed: "#22c55e",
  Open: "#f59e0b",
  Overdue: "#ef4444",
};

function ChartCard({ title, subtitle, children }) {
  return (
    <div className="bg-white dark:bg-[#141414] rounded-2xl border border-gray-200 dark:border-gray-800 p-5 shadow-sm">
      <h3 className="font-semibold text-sm">{title}</h3>
      {subtitle && <p className="text-xs text-gray-400 dark:text-gray-500 mb-3">{subtitle}</p>}
      <div className="h-80 w-full mt-2">{children}</div>
    </div>
  );
}

// Theme-aware text + tooltip: white text in dark mode, black in light mode.
function tooltipProps(dark) {
  const fg = dark ? "#f3f4f6" : "#111827";
  return {
    contentStyle: {
      background: dark ? "rgba(20,20,20,0.97)" : "#ffffff",
      border: dark ? "1px solid #2a2a2a" : "1px solid #e5e7eb",
      borderRadius: 10,
      fontSize: 12,
      color: fg,
    },
    itemStyle: { color: fg },
    labelStyle: { color: fg, fontWeight: 600 },
  };
}
function axisTick(dark) {
  return { fontSize: 11, fill: dark ? "#cbd5e1" : "#374151" };
}
function legendStyle(dark) {
  return { fontSize: 12, color: dark ? "#e5e7eb" : "#374151" };
}
// Shorten long board/person names on an axis; the full name still shows in the tooltip.
function truncTick(value) {
  const s = String(value ?? "");
  return s.length > 16 ? s.slice(0, 15) + "…" : s;
}

export function StatusDonut({ completed, open, overdue, dark }) {
  const data = [
    { name: "Completed", value: completed },
    { name: "Open", value: open },
    { name: "Overdue", value: overdue },
  ].filter((d) => d.value > 0);

  return (
    <ChartCard title="Task Status Split" subtitle="Across the current filter">
      <ResponsiveContainer>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius={60} outerRadius={95} paddingAngle={3}>
            {data.map((d) => (
              <Cell key={d.name} fill={STATUS_COLORS[d.name]} />
            ))}
          </Pie>
          <Tooltip {...tooltipProps(dark)} />
          <Legend iconType="circle" wrapperStyle={legendStyle(dark)} />
        </PieChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function PerAssigneeBar({ rows, dark }) {
  const [selected, setSelected] = useState(null); // null => default top 12
  const [q, setQ] = useState("");

  const total = (r) => (r.completed || 0) + (r.pending || 0) + (r.overdue || 0);
  const all = useMemo(() => [...(rows || [])].sort((a, b) => total(b) - total(a)), [rows]);
  const top12 = useMemo(() => all.slice(0, 12).map((r) => r.assignee), [all]);
  const shownSet = useMemo(() => new Set(selected ?? top12), [selected, top12]);

  const data = all
    .filter((r) => shownSet.has(r.assignee))
    .map((r) => ({ name: r.assignee, Completed: r.completed, Pending: r.pending, Overdue: r.overdue }));

  function toggle(name) {
    setSelected((prev) => {
      const base = prev ?? top12;
      return base.includes(name) ? base.filter((n) => n !== name) : [...base, name];
    });
  }

  const s = q.trim().toLowerCase();
  const listed = s ? all.filter((r) => r.assignee.toLowerCase().includes(s)) : all;

  return (
    <ChartCard
      title="Workload by Assignee"
      subtitle={`Completed vs pending vs overdue · showing ${data.length} of ${all.length}`}
    >
      <div className="flex gap-3 h-full">
        {/* people picker — tick to add, untick to remove */}
        <div className="w-44 shrink-0 flex flex-col border border-gray-200 dark:border-gray-800 rounded-xl p-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search person…"
            className="filter-input mb-2 text-xs"
          />
          <div className="flex items-center justify-between text-[11px] text-gray-400 mb-1 px-1">
            <span>{data.length} shown</span>
            <button
              onClick={() => {
                setSelected(null);
                setQ("");
              }}
              className="text-indigo-500 hover:underline"
            >
              Reset top 12
            </button>
          </div>
          <div className="flex-1 overflow-y-auto pr-1 space-y-0.5">
            {listed.map((r) => (
              <label
                key={r.assignee}
                className="flex items-center gap-2 text-xs px-1 py-1 rounded-md hover:bg-gray-100 dark:hover:bg-[#1a1a1a] cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={shownSet.has(r.assignee)}
                  onChange={() => toggle(r.assignee)}
                  className="accent-indigo-500"
                />
                <span className="truncate" title={r.assignee}>
                  {r.assignee}
                </span>
                <span className="ml-auto text-gray-400">{total(r)}</span>
              </label>
            ))}
            {listed.length === 0 && <p className="text-xs text-gray-400 px-1 py-2">No match.</p>}
          </div>
        </div>

        {/* chart */}
        <div className="flex-1 min-w-0">
          {data.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-gray-400">
              Pick people on the left to show them here.
            </div>
          ) : (
            <ResponsiveContainer>
              <BarChart data={data} margin={{ top: 10, right: 10, left: -10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" />
                <XAxis
                  dataKey="name"
                  angle={-35}
                  textAnchor="end"
                  interval={0}
                  height={84}
                  tickMargin={8}
                  tickFormatter={truncTick}
                  tick={axisTick(dark)}
                />
                <YAxis allowDecimals={false} tick={axisTick(dark)} />
                <Tooltip {...tooltipProps(dark)} cursor={{ fill: "rgba(128,128,128,0.1)" }} />
                <Legend verticalAlign="top" align="center" wrapperStyle={{ ...legendStyle(dark), paddingBottom: 8 }} />
                <Bar dataKey="Completed" stackId="a" fill="#22c55e" />
                <Bar dataKey="Pending" stackId="a" fill="#f59e0b" />
                <Bar dataKey="Overdue" stackId="a" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </ChartCard>
  );
}

export function PerProjectBar({ rows, dark }) {
  const data = (rows || []).slice(0, 10);

  return (
    <ChartCard title="Tasks by Board / Project" subtitle="Total vs completed (top 10)">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 10, right: 10, left: -10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" />
          <XAxis
            dataKey="name"
            angle={-35}
            textAnchor="end"
            interval={0}
            height={84}
            tickMargin={8}
            tickFormatter={truncTick}
            tick={axisTick(dark)}
          />
          <YAxis allowDecimals={false} tick={axisTick(dark)} />
          <Tooltip {...tooltipProps(dark)} cursor={{ fill: "rgba(128,128,128,0.1)" }} />
          <Legend verticalAlign="top" align="center" wrapperStyle={{ ...legendStyle(dark), paddingBottom: 8 }} />
          <Bar dataKey="Total" fill="#6366f1" radius={[4, 4, 0, 0]} />
          <Bar dataKey="Completed" fill="#22c55e" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
