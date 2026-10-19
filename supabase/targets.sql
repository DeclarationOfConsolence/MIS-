-- ============================================================
-- NapChief MIS — Weekly Target Tracker (Actual / Target / Diff)
-- Run this in Supabase -> SQL Editor -> New query -> Run.
-- Safe to run multiple times.
-- ============================================================

-- One row per (person, category, week). Each week starts blank — no carry-
-- forward from a previous week's target. category is 'one_time' | 'todo' | 'meeting'.
create table if not exists mis_targets (
  assignee     text not null,
  category     text not null check (category in ('one_time', 'todo', 'meeting')),
  week_start   date not null,   -- Monday of the week this target applies to
  target_score integer,         -- same -100..0 convention as the dashboard's scores
  updated_at   timestamptz default now(),
  primary key (assignee, category, week_start)
);
create index if not exists idx_mis_targets_week on mis_targets (week_start);
alter table mis_targets enable row level security;
