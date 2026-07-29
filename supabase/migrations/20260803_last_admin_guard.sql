-- Last-admin guard: a system with zero active admins is unrecoverable, so
-- block demoting, deactivating, or deleting the last remaining one. This is
-- the real enforcement layer for the Users & Roles rebuild's last-admin
-- rule — the UI does a friendlier pre-flight check first, but this trigger
-- is what actually can't be bypassed, matching this project's RLS/DB-first
-- enforcement philosophy.

create or replace function public.protect_last_admin()
returns trigger
language plpgsql
as $$
declare
  v_would_lose_admin boolean;
  v_other_active_admins int;
begin
  if old.role <> 'admin' then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  v_would_lose_admin := (tg_op = 'DELETE')
    or (new.role <> 'admin')
    or (new.is_locked = true and old.is_locked = false);

  if not v_would_lose_admin then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  select count(*) into v_other_active_admins
  from public.profiles
  where role = 'admin'
    and is_locked = false
    and user_id <> old.user_id;

  if v_other_active_admins = 0 then
    raise exception 'At least one admin is required.';
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists trg_protect_last_admin on public.profiles;
create trigger trg_protect_last_admin
  before update or delete on public.profiles
  for each row
  execute function public.protect_last_admin();
