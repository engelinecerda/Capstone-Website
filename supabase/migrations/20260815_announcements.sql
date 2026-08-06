-- Announcements (Maintenance module, Part B) — admin-authored notices shown
-- as a banner on customer-facing pages, each with an optional display
-- window. This is content plus a "show between these dates" rule only — it
-- never changes system behaviour (that's Maintenance Mode, a separate,
-- not-yet-built Part C).

create table if not exists public.announcement (
  id             uuid primary key default gen_random_uuid(),
  message        text not null,
  kind           text not null default 'info'
                   check (kind in ('info', 'scheduled_maintenance', 'urgent')),
  is_enabled     boolean not null default true,
  starts_at      timestamptz,                 -- null = show immediately
  ends_at        timestamptz,                 -- null = show until disabled
  is_dismissible boolean not null default true,
  link_label     text,
  link_url       text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references auth.users(id),
  constraint announcement_window_order
    check (starts_at is null or ends_at is null or starts_at < ends_at)
);

-- "Active" is never stored — js/announcement_helpers.js derives it from
-- is_enabled + starts_at/ends_at against the current time on every read, on
-- both the admin list and the customer banner, so nothing can go stale.

create or replace function public.set_announcement_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_announcement_set_updated_at on public.announcement;
create trigger trg_announcement_set_updated_at
  before update on public.announcement
  for each row
  execute function public.set_announcement_updated_at();

alter table public.announcement enable row level security;

-- Public read — customers must see active announcements without being
-- logged in; the active/priority filter happens in the querying code, not
-- here, so admins can also see scheduled/expired/disabled rows in the list.
drop policy if exists "Public read announcements" on public.announcement;
create policy "Public read announcements" on public.announcement
  for select using (true);

drop policy if exists "Admin manage announcements" on public.announcement;
create policy "Admin manage announcements" on public.announcement
  for all using (get_my_role() = 'admin') with check (get_my_role() = 'admin');
