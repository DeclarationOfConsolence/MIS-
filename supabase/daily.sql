-- ============================================================
-- NapChief MIS — DAILY to-do completion tracking
-- Run this in Supabase -> SQL Editor -> New query -> Run.
-- Safe to run multiple times.
--
-- Tracks how many times each person ticks their DAILY to-do tasks.
-- Target: 6 ticks/week (Mon–Sat). Tasks are grouped by ASSIGNEE; every
-- assigned daily task shows on the scorecard (never-ticked = 0/6).
-- ============================================================

-- ---- One row per (task, person, day) ----------------------
create table if not exists mis_daily_completions (
  task_gid       text not null,
  task_name      text,
  board          text,
  section        text,
  person         text not null,      -- who ticked it (story actor)
  completed_date date not null,      -- the day, in IST
  completed_at   timestamptz,        -- exact instant of the (earliest) tick that day
  synced_at      timestamptz default now(),
  primary key (task_gid, person, completed_date)
);
create index if not exists idx_mdc_person on mis_daily_completions (person);
create index if not exists idx_mdc_date   on mis_daily_completions (completed_date);
create index if not exists idx_mdc_task   on mis_daily_completions (task_gid);
alter table mis_daily_completions enable row level security;

-- ---- Roster: every daily task (with its assignee) ----------
-- The full list of daily tasks from every "To do" board's DAILY section,
-- so a task that was NEVER ticked still appears on the scorecard as 0/6.
-- Refreshed (replace-on-sync) on every daily sync. Grouped by assignee;
-- unassigned daily tasks are skipped at sync time, so assignee is always set.
create table if not exists mis_daily_tasks (
  task_gid    text primary key,
  task_name   text,
  board       text,
  section     text,
  assignee    text not null,     -- the person this daily task belongs to
  synced_at   timestamptz default now()
);
create index if not exists idx_mdt_assignee on mis_daily_tasks (assignee);
alter table mis_daily_tasks enable row level security;

-- ---- Scorecard: per person (assignee), per task, in a date range ----
-- Driven by the ROSTER, so EVERY daily task shows up — including ones never
-- ticked, which come back as done=0 / dates=[] (the app draws them as 0/6).
-- Completions are LEFT JOINed in: a tick counts for the day the task was
-- completed, regardless of who clicked it. Sundays are excluded. The app
-- computes the "X / 6" target and the missed days from the range + dates.
create or replace function mis_daily_scorecard(p_from date, p_to date)
returns jsonb language sql stable as $$
  with ticks as (
    -- one row per (task, day) it was ticked in range — actor-agnostic
    select task_gid, completed_date
    from mis_daily_completions
    where completed_date between p_from and p_to
      and extract(dow from completed_date) <> 0   -- exclude Sundays
    group by task_gid, completed_date
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'person',   assignee,
      'task_gid', task_gid,
      'task',     task_name,
      'board',    board,
      'done',     done,
      'dates',    dates
    ) order by assignee, task_name
  ), '[]'::jsonb)
  from (
    select r.assignee, r.task_gid, r.task_name, r.board,
           count(t.completed_date) as done,
           coalesce(
             jsonb_agg(t.completed_date order by t.completed_date)
               filter (where t.completed_date is not null),
             '[]'::jsonb
           ) as dates
    from mis_daily_tasks r
    left join ticks t on t.task_gid = r.task_gid
    group by r.assignee, r.task_gid, r.task_name, r.board
  ) s;
$$;

-- ============================================================
-- After running this:
--   npm run sync:daily        (populate from Asana — read-only on Asana)
--   or just wait for the hourly sync, which now also runs the daily step.
-- ============================================================
