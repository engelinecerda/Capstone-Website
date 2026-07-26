-- Package badges (Phase 1 — merchandising labels only, no pricing/discount
-- logic). Replaces the hardcoded "Best value = highest price in category"
-- marker in js/packages.js with an admin-assignable, data-driven system.
--
-- badge         = catalogue of assignable/derived badge types.
-- package_badge = admin-assigned badges on a package. best_seller has NO
--                 rows here — it is derived at read time from booking
--                 counts via get_best_seller_package_ids(), never hand-
--                 assigned (is_assignable = false).

create table if not exists public.badge (
  badge_id      uuid primary key default gen_random_uuid(),
  badge_key     text not null unique,
  label         text not null,
  -- Maps onto the shared status-pill palette (manager-theme.css
  -- --pending/--approved/--info/--neutral) so rendering code never needs
  -- its own colour lookup — it interpolates this straight into a class name.
  variant       text not null check (variant in ('pending','approved','info','neutral')) default 'neutral',
  -- 'category' = at most one package per package_category_id may hold this
  -- badge; 'global' = at most one package overall; null = no constraint.
  unique_scope  text check (unique_scope in ('category','global')) default null,
  is_assignable boolean not null default true,
  sort_order    int not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- best_seller ships in automatic mode (is_assignable = false) but its
-- unique_scope is already 'category' — the admin can flip is_assignable to
-- true from the Bookable Inventory badge modal to switch it to manual
-- (admin hand-picks it per category, same as Best Value); flipping back to
-- automatic clears any manual assignments so the derived winner takes over
-- cleanly. See js/super_admin_packages.js toggleBestSellerMode().
insert into public.badge (badge_key, label, variant, unique_scope, is_assignable, sort_order)
values
  ('best_value',  'Best Value',  'pending',  'category', true,  10),
  ('best_seller', 'Best Seller', 'approved', 'category', false, 20),
  ('popular',     'Popular',     'info',     null,       true,  30)
on conflict (badge_key) do nothing;

create table if not exists public.package_badge (
  package_badge_id uuid primary key default gen_random_uuid(),
  package_id  uuid not null references public.package(package_id) on delete cascade,
  badge_id    uuid not null references public.badge(badge_id) on delete cascade,
  assigned_by uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  unique (package_id, badge_id)
);

create index if not exists idx_package_badge_package on public.package_badge(package_id);
create index if not exists idx_package_badge_badge   on public.package_badge(badge_id);

-- RLS — same admin-only-write / public-read convention as venue/package_venue
-- (20260725_bookable_inventory.sql).
alter table public.badge enable row level security;

create policy "Public read active badges" on public.badge for select using (is_active = true);

create policy "Admin read all badges" on public.badge for select using (
  exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role in ('admin','manager','staff'))
);

create policy "Admin manage badges" on public.badge for all
  using (get_my_role() = 'admin') with check (get_my_role() = 'admin');

alter table public.package_badge enable row level security;

create policy "Public read package_badge" on public.package_badge for select using (true);

create policy "Admin manage package_badge" on public.package_badge for all
  using (get_my_role() = 'admin') with check (get_my_role() = 'admin');

-- Category-scoped (or global-scoped) uniqueness safety net. The admin UI
-- pre-checks and offers a "move it here?" prompt before writing; this
-- trigger is the DB-level backstop, since a plain unique index can't reach
-- across to package.package_category_id.
create or replace function public.enforce_badge_unique_scope()
returns trigger
language plpgsql
as $$
declare
  v_scope       text;
  v_category_id uuid;
  v_conflicts   int;
begin
  select unique_scope into v_scope from public.badge where badge_id = new.badge_id;
  if v_scope is null then
    return new;
  end if;

  select package_category_id into v_category_id from public.package where package_id = new.package_id;

  if v_scope = 'global' then
    select count(*) into v_conflicts
    from public.package_badge pb
    where pb.badge_id = new.badge_id
      and pb.package_badge_id <> new.package_badge_id;
  else -- 'category'
    select count(*) into v_conflicts
    from public.package_badge pb
    join public.package p on p.package_id = pb.package_id
    where pb.badge_id = new.badge_id
      and p.package_category_id is not distinct from v_category_id
      and pb.package_badge_id <> new.package_badge_id;
  end if;

  if v_conflicts > 0 then
    raise exception 'Badge already assigned to another package in this scope' using errcode = '23505';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_badge_unique_scope on public.package_badge;
create trigger trg_enforce_badge_unique_scope
  before insert or update on public.package_badge
  for each row
  execute function public.enforce_badge_unique_scope();

-- Derived Best Seller: per package_category_id, the package with the most
-- non-cancelled/non-declined reservations (completed events count toward
-- "most booked historically" — the opposite bias from
-- is_capacity_blocking_reservation_status(), which excludes completed
-- because finished events don't occupy future capacity). Add-ons are never
-- eligible. A category with zero qualifying bookings gets no winner.
-- Resolved at read time on every call — no cron, no stored/stale row.
create or replace function public.get_best_seller_package_ids(p_category_id uuid default null)
returns table (
  package_category_id uuid,
  package_id           uuid,
  booking_count        bigint
)
language sql
security definer
set search_path = public
stable
as $$
  with counts as (
    select
      p.package_category_id,
      p.package_id,
      p.created_at,
      count(r.reservation_id) as booking_count
    from public.package p
    join public.reservations r on r.package_id = p.package_id
    where p.package_type <> 'add on'
      and p.package_category_id is not null
      and r.status not in ('cancelled', 'declined')
      and (p_category_id is null or p.package_category_id = p_category_id)
    group by p.package_category_id, p.package_id, p.created_at
  ),
  ranked as (
    select *,
      row_number() over (
        partition by package_category_id
        order by booking_count desc, created_at asc, package_id asc
      ) as rn
    from counts
    where booking_count > 0
  )
  select package_category_id, package_id, booking_count
  from ranked
  where rn = 1;
$$;

grant execute on function public.get_best_seller_package_ids(uuid) to anon, authenticated;
