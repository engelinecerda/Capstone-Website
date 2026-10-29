-- Category visibility is already enforced by package_category RLS. This
-- trigger also blocks crafted reservation inserts/changes that target an
-- active package whose parent category has been archived.
create or replace function public.reject_archived_category_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_category_id uuid;
  v_category_active boolean;
begin
  if tg_op = 'UPDATE' and new.package_id is not distinct from old.package_id then
    return new;
  end if;

  select p.package_category_id, pc.is_active
    into v_category_id, v_category_active
    from public.package p
    left join public.package_category pc
      on pc.package_category_id = p.package_category_id
   where p.package_id = new.package_id;

  if v_category_id is not null and v_category_active is not true then
    raise exception using errcode = 'P0001',
      message = 'Selected package belongs to an archived category and is no longer bookable.';
  end if;
  return new;
end;
$$;
revoke all on function public.reject_archived_category_booking() from public, anon, authenticated;

drop trigger if exists reject_archived_category_booking on public.reservations;
create trigger reject_archived_category_booking
before insert or update of package_id on public.reservations
for each row execute function public.reject_archived_category_booking();

notify pgrst, 'reload schema';
