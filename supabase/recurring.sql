-- ============================================================
-- NapChief MIS — WEEKLY / MONTHLY recurring to-do tracking
-- Run this in Supabase -> SQL Editor -> New query -> Run.
-- Safe to run multiple times.
--
-- SEPARATE from the daily tables — this does NOT touch mis_daily_* or the
-- daily scorecard in any way. It only adds the two tables + function below.
--
-- A recurring task carries a DUE DATE. We rebuild, per cycle, whether it was
-- done ON TIME (ticked on/before the due date) or MISSED (due date passed
-- with no on-time tick; late counts as missed). Grouped by assignee.
-- ============================================================

-- ---- Roster: every weekly/monthly task (with its assignee + current due) ----
create table if not exists mis_recurring_tasks (
  task_gid    text not null,
  kind        text not null,            -- 'weekly' | 'monthly'
  task_name   text,
  board       text,
  section     text,
  assignee    text not null,
  current_due date,
  has_due     boolean default true,     -- false => no due date set (can't be scored)
  synced_at   timestamptz default now(),
  primary key (task_gid, kind)
);
create index if not exists idx_mrt_assignee on mis_recurring_tasks (assignee);
create index if not exists idx_mrt_kind     on mis_recurring_tasks (kind);
alter table mis_recurring_tasks enable row level security;

-- ---- One row per (task, kind, due_date) cycle ----
create table if not exists mis_recurring_cycles (
  task_gid     text not null,
  kind         text not null,
  due_date     date not null,           -- the due date of that cycle
  status       text not null,           -- 'on_time' | 'late' | 'missed'
  completed_on date,                     -- when it was ticked (null if never)
  synced_at    timestamptz default now(),
  primary key (task_gid, kind, due_date)
);
create index if not exists idx_mrc_task on mis_recurring_cycles (task_gid, kind);
create index if not exists idx_mrc_due  on mis_recurring_cycles (due_date);
alter table mis_recurring_cycles enable row level security;

-- ---- Scorecard: every roster task of a kind, with its cycles in [p_from,p_to] ----
-- Driven by the roster (LEFT JOIN), so EVERY task shows — including ones with
-- no cycle in range (they come back with cycles=[]; the app draws "·"). Tasks
-- with no due date come back has_due=false and are shown tagged, not scored.
create or replace function mis_recurring_scorecard(p_kind text, p_from date, p_to date)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'person',      assignee,
      'task_gid',    task_gid,
      'task',        task_name,
      'board',       board,
      'current_due', current_due,
      'has_due',     has_due,
      'cycles',      cycles
    ) order by assignee, task_name
  ), '[]'::jsonb)
  from (
    select r.assignee, r.task_gid, r.task_name, r.board, r.current_due, r.has_due,
      coalesce(
        jsonb_agg(jsonb_build_object('due', c.due_date, 'status', c.status) order by c.due_date)
          filter (where c.due_date is not null),
        '[]'::jsonb
      ) as cycles
    from mis_recurring_tasks r
    left join mis_recurring_cycles c
      on c.task_gid = r.task_gid
     and c.kind = r.kind
     and c.due_date between p_from and p_to
    where r.kind = p_kind
    group by r.assignee, r.task_gid, r.task_name, r.board, r.current_due, r.has_due
  ) s;
$$;

-- ============================================================
-- After running this:
--   npm run sync:recurring     (populate from Asana — read-only on Asana)
--   or just wait for the hourly sync, which now also runs this step.
-- ============================================================
