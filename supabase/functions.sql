-- ============================================================
-- NapChief MIS Dashboard — database functions for FAST queries
-- Run this in Supabase -> SQL Editor -> New query -> Run.
-- Safe to run multiple times (uses CREATE OR REPLACE).
-- No re-sync needed.
-- ============================================================

-- Indexes that make filtering by project/section instant
create index if not exists idx_mis_tasks_projects_gin on mis_tasks using gin (projects);
create index if not exists idx_mis_tasks_sections_gin on mis_tasks using gin (sections);

-- Section from the assignee's OWN board (so a person's sections aren't borrowed
-- from shared boards). Populated by the sync.
alter table mis_tasks add column if not exists own_section text;
create index if not exists idx_mis_tasks_own_section on mis_tasks (own_section);

-- Archived tasks (in an "Archived" section, or on an archived board). Kept in the
-- table but HIDDEN by default everywhere; viewable via the Status = 'Archived' filter.
alter table mis_tasks add column if not exists archived boolean default false;
create index if not exists idx_mis_tasks_archived on mis_tasks (archived);

-- ---- Aggregates: KPIs + per-assignee + per-project (with filters) ----
create or replace function mis_summary(
  p_assignee text default null,
  p_project  text default null,
  p_section  text default null,
  p_status   text default null,
  p_from     date default null,
  p_to       date default null,
  p_search   text default null,
  p_archived boolean default false
) returns jsonb language sql stable as $$
  with base as (
    -- all filters EXCEPT completion-status and archived
    select * from mis_tasks t
    where (p_assignee is null or t.assignee = p_assignee)
      and (p_project  is null or coalesce(t.projects, '[]'::jsonb) ? p_project)
      and (p_section  is null or t.own_section = p_section)
      and (p_from   is null or (t.created_at at time zone 'Asia/Kolkata')::date >= p_from)
      and (p_to     is null or (t.created_at at time zone 'Asia/Kolkata')::date <= p_to)
      and (p_search is null or t.name ilike '%'||p_search||'%' or t.assignee ilike '%'||p_search||'%')
  ),
  f as (
    select * from base t
    where (p_status   is null
           or (p_status = 'Completed' and t.completed)
           or (p_status = 'Open'      and not t.completed)
           or (p_status = 'Overdue'   and not t.completed and t.due_on < current_date))
      and coalesce(t.archived, false) = p_archived
  )
  select jsonb_build_object(
    'kpis', (
      select jsonb_build_object(
        'total',     count(*),
        'completed', count(*) filter (where completed),
        'open',      count(*) filter (where not completed),
        'overdue',   count(*) filter (where not completed and due_on < current_date),
        'archived',  (select count(*) from base where coalesce(archived, false) = true)
      ) from f
    ),
    -- Per-person table: ALL columns are ONE-TIME tasks only.
    'perAssignee', (
      select coalesce(jsonb_agg(r), '[]'::jsonb) from (
        select jsonb_build_object(
          'assignee',  assignee,
          'total',     count(*) filter (where is_one_time),
          'completed', count(*) filter (where is_one_time and completed),
          'pending',   count(*) filter (where is_one_time and not completed),
          'overdue',   count(*) filter (where is_one_time and not completed and due_on < current_date),
          'pct',       coalesce(round(100.0 * count(*) filter (where is_one_time and completed)
                               / nullif(count(*) filter (where is_one_time), 0)), 0)
        ) r
        from f
        group by assignee
        having count(*) filter (where is_one_time) > 0   -- only people with one-time tasks
        order by count(*) filter (where is_one_time) desc
      ) s
    ),
    'perProject', (
      select coalesce(jsonb_agg(r), '[]'::jsonb) from (
        select jsonb_build_object('name', proj, 'Total', count(*), 'Completed', count(*) filter (where completed)) r
        from (
          select jsonb_array_elements_text(coalesce(projects, '[]'::jsonb)) proj, completed from f
        ) x
        group by proj order by count(*) desc limit 10
      ) s
    )
  );
$$;

-- ---- Dropdown lists + total count + last-synced ----
create or replace function mis_filter_lists() returns jsonb language sql stable as $$
  select jsonb_build_object(
    'assignees', (select coalesce(jsonb_agg(a order by a), '[]'::jsonb)
                  from (select distinct assignee a from mis_tasks where assignee is not null and coalesce(archived,false)=false) x),
    'projects',  (select coalesce(jsonb_agg(p order by p), '[]'::jsonb)
                  from (select distinct jsonb_array_elements_text(coalesce(projects, '[]'::jsonb)) p from mis_tasks where coalesce(archived,false)=false) x),
    'sections',  (select coalesce(jsonb_agg(s order by s), '[]'::jsonb)
                  from (select distinct own_section s from mis_tasks where own_section is not null and coalesce(archived,false)=false) x),
    'taskCount', (select count(*) from mis_tasks where coalesce(archived,false)=false),
    'lastSynced',(select value from mis_meta where key = 'last_synced')
  );
$$;

-- ---- Performance: one-time COMPLETION per person ----
-- Score = (completed ÷ total) − 100  →  0% = ALL done (best), −100% = none done (worst).
-- Gradual (half done ≈ −50%). The delayed/overdue/revised columns stay as info,
-- but no longer affect the score itself.
alter table mis_tasks add column if not exists original_due_on date;
alter table mis_tasks add column if not exists one_time_section text;

-- One-time SUBTASKS, counted as extra one-time tasks for the subtask's OWN
-- assignee. Populated by the sync from subtasks of one-time parent tasks (one
-- level deep). Kept in a SEPARATE table so it affects ONLY the One-Time
-- scorecard — the KPI tiles, Tasks, Team and Planned-vs-Actual never read it.
create table if not exists mis_one_time_subtasks (
  gid              text primary key,
  parent_gid       text,
  name             text,
  assignee         text,
  completed        boolean,
  completed_at     timestamptz,
  due_on           date,
  original_due_on  date,
  created_at       timestamptz,
  one_time_section text,
  archived         boolean default false,
  synced_at        timestamptz
);
create index if not exists idx_mots_assignee on mis_one_time_subtasks (assignee);
alter table mis_one_time_subtasks enable row level security;

-- Optional DUE-date window (p_from / p_to). Both null => counts ALL one-time
-- items. When set => only those DUE in [p_from, p_to] (by due_on). Counts now
-- include one-time SUBTASKS (each under its OWN assignee); scoring is unchanged.
drop function if exists mis_performance();
create or replace function mis_performance(p_from date default null, p_to date default null) returns jsonb language sql stable as $$
  with src as (
    -- parent one-time tasks
    select assignee, completed, completed_at, due_on, original_due_on
    from mis_tasks
    where is_one_time and coalesce(archived, false) = false
    union all
    -- one-time subtasks, attributed to the subtask's OWN assignee
    select assignee, completed, completed_at, due_on, original_due_on
    from mis_one_time_subtasks
    where coalesce(archived, false) = false
  ),
  p as (
    select assignee,
      count(*) as total,
      count(*) filter (where completed) as completed,
      count(*) filter (where not completed) as pending,
      count(*) filter (where not completed and due_on < current_date) as overdue,
      count(*) filter (where completed and due_on is not null and completed_at is not null and completed_at::date <= due_on) as on_time,
      count(*) filter (where completed and due_on is not null and completed_at is not null and completed_at::date >  due_on) as delayed,
      count(*) filter (where completed and due_on is not null and completed_at is not null and (completed_at::date - due_on) > 7) as late_over_7,
      count(*) filter (where completed and (due_on is null or completed_at is null)) as no_due,
      count(*) filter (where original_due_on is not null and due_on is not null and abs(due_on - original_due_on) > 7) as revised,
      coalesce(sum(current_date - due_on) filter (where not completed and due_on < current_date), 0) as days_overdue,
      coalesce(sum(completed_at::date - due_on) filter (where completed and due_on is not null and completed_at is not null and completed_at::date > due_on), 0) as days_late
    from src
    where (p_from is null or due_on >= p_from)
      and (p_to   is null or due_on <= p_to)
    group by assignee
    having count(*) > 0
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'assignee', assignee, 'total', total, 'completed', completed, 'pending', pending, 'overdue', overdue,
    'on_time', on_time, 'delayed', delayed, 'no_due', no_due, 'revised', revised,
    'days_overdue', days_overdue, 'days_late', days_late,
    -- >7-days-late completions are excluded from BOTH top & bottom (neutral); still shown in 'delayed'.
    'score', coalesce(round(100.0 * (completed - late_over_7) / nullif(total - late_over_7, 0)), 0) - 100
  ) order by coalesce(round(100.0 * (completed - late_over_7) / nullif(total - late_over_7, 0)), 0) - 100 asc), '[]'::jsonb)
  from p;
$$;

-- ---- Daily snapshot of one-time tasks (for Planned vs Actual "Fixed" mode) ----
-- Each sync UPSERTS every one-time task's CURRENT state into the row tagged with
-- TODAY's IST date (snap_date, gid). Today's row keeps getting overwritten during
-- the day, so by day's end it equals the end-of-day state; a PAST date's row is
-- never touched again → frozen. "Fixed" mode reads the row at the END of the range,
-- so a review of a past week never changes even if tasks are rescheduled afterward.
create table if not exists mis_due_snapshots (
  snap_date        date not null,
  gid              text not null,
  assignee         text,
  due_on           date,
  completed        boolean,
  completed_at     timestamptz,
  is_one_time      boolean,
  archived         boolean,
  original_due_on  date,
  created_at       timestamptz,
  primary key (snap_date, gid)
);
create index if not exists idx_mds_assignee on mis_due_snapshots (snap_date, assignee);
create index if not exists idx_mds_due on mis_due_snapshots (snap_date, due_on);
alter table mis_due_snapshots enable row level security;

-- Retention: drop daily snapshots older than N days, but KEEP every SUNDAY
-- snapshot forever (cheap week-boundary history for long-term reviews).
create or replace function mis_prune_snapshots(p_keep_days int default 120) returns void language sql as $$
  delete from mis_due_snapshots
  where snap_date < (current_date - p_keep_days)
    and extract(dow from snap_date) <> 0;   -- 0 = Sunday → kept forever
$$;

-- ---- Planned vs Actual: one-time tasks by PLANNED END DATE vs ACTUAL END DATE ----
-- p_from/p_to filter by the (frozen) Planned End Date; both null = all time.
-- "Done" = an Actual End Date is set. The score credits anything done WITHIN 1 WEEK
-- of the planned date (on-time OR ≤7 days late). Done MORE than 1 week late is
-- NEUTRAL — excluded from both sides of the score — and reported as delay_over_1week.
-- Dynamic/Fixed removed: the Planned End Date is frozen at sync time, so it never moves.
drop function if exists mis_planned_actual(date, date, date);
drop function if exists mis_planned_actual(date, date);
create or replace function mis_planned_actual(p_from date default null, p_to date default null)
returns jsonb language sql stable as $$
  with p as (
    select assignee,
      -- total = planned + unplanned (both range-scoped): planned tasks whose Planned End Date is in range,
      -- plus unplanned tasks created in range. Follows the date range like the two columns it sums.
      count(*) filter (where (planned_end_date is not null and (p_from is null or planned_end_date::date >= p_from) and (p_to is null or planned_end_date::date <= p_to))
                          or (planned_end_date is null and (p_from is null or created_at::date >= p_from) and (p_to is null or created_at::date <= p_to))) as total,
      -- unplanned = no Planned End Date set. Follows the SAME date range, but measured on the task's
      -- CREATED date (created_at), not planned end date — a task with no plan counts if it was created in the range.
      count(*) filter (where planned_end_date is null and (p_from is null or created_at::date >= p_from) and (p_to is null or created_at::date <= p_to)) as unplanned,
      -- planned + all scored columns RESPECT the date range: only tasks whose Planned End Date falls in it.
      count(*) filter (where planned_end_date is not null and (p_from is null or planned_end_date::date >= p_from) and (p_to is null or planned_end_date::date <= p_to)) as planned,
      count(*) filter (where planned_end_date is not null and (p_from is null or planned_end_date::date >= p_from) and (p_to is null or planned_end_date::date <= p_to) and actual_end_date is not null and actual_end_date::date <= planned_end_date::date) as on_time,
      count(*) filter (where planned_end_date is not null and (p_from is null or planned_end_date::date >= p_from) and (p_to is null or planned_end_date::date <= p_to) and actual_end_date is not null and actual_end_date::date > planned_end_date::date and (actual_end_date::date - planned_end_date::date) <= 7) as late,
      count(*) filter (where planned_end_date is not null and (p_from is null or planned_end_date::date >= p_from) and (p_to is null or planned_end_date::date <= p_to) and actual_end_date is not null and (actual_end_date::date - planned_end_date::date) > 7) as late_over_7,
      count(*) filter (where planned_end_date is not null and (p_from is null or planned_end_date::date >= p_from) and (p_to is null or planned_end_date::date <= p_to) and actual_end_date is null) as not_done
    from mis_tasks
    where is_one_time
      and coalesce(archived, false) = false
    group by assignee
    having count(*) > 0
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'assignee', assignee, 'total', total, 'unplanned', unplanned, 'planned', planned,
    'on_time', on_time, 'late', late,
    'delay_over_1week', late_over_7, 'not_done', not_done,
    -- done within 1 week counts; >1 week late is NEUTRAL (excluded top & bottom), shown as delay_over_1week.
    -- No scorable planned tasks (planned = 0, or all of them are >1wk-late neutral) → score is null (shown as "—"), not −100.
    'score', case when (planned - late_over_7) > 0
                  then round(100.0 * (on_time + late) / (planned - late_over_7)) - 100
                  else null end
  ) order by (case when (planned - late_over_7) > 0
                  then round(100.0 * (on_time + late) / (planned - late_over_7)) - 100
                  else null end) asc nulls last), '[]'::jsonb)
  from p;
$$;
