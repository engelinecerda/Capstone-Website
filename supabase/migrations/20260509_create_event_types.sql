-- ── Event Types table ──────────────────────────────────────────────────────
create table if not exists public.event_types (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  status      text not null default 'Active' check (status in ('Active', 'Archived')),
  created_at  timestamptz not null default now()
);

-- Allow anyone (including unauthenticated customers on the booking form) to
-- read active event types.
alter table public.event_types enable row level security;

create policy "Public can read active event types"
  on public.event_types for select
  using (status = 'Active');

-- Admins (authenticated with a staff/super-admin role) can manage all rows.
create policy "Admins can manage event types"
  on public.event_types for all
  using (auth.role() = 'authenticated');

-- ── Seed data ───────────────────────────────────────────────────────────────
insert into public.event_types (name, description, status) values
  ('Birthday Party',        'Celebrations for birthdays of all ages',                 'Active'),
  ('Debut',                 '18th birthday celebration (cotillion)',                  'Active'),
  ('Wedding Reception',     'Post-ceremony reception and dinner',                     'Active'),
  ('Corporate Event',       'Team-building, seminar, or company celebration',         'Active'),
  ('Graduation Party',      'Celebration of academic milestones',                     'Active'),
  ('Christening / Baptism', 'Religious and family gathering',                         'Active'),
  ('Anniversary',           'Milestone couple or business anniversary',               'Active'),
  ('Reunion',               'Family or class reunion gatherings',                     'Active')
on conflict do nothing;
