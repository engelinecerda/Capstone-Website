-- Exactly one shared board (staff) account.
--
-- The kiosk/board login is a single shared account (role = 'staff',
-- is_board_account = true). create-staff-account already refuses to make a
-- second one; these indexes make the database itself enforce it, so a race
-- between two requests or a direct profiles edit can't create another.

-- At most one profile flagged as the board account.
create unique index if not exists profiles_single_board_account
  on public.profiles (is_board_account)
  where is_board_account;

-- At most one profile with role 'staff'. Guarded: if legacy individual staff
-- accounts still exist (they are meant to be removed, see
-- 20260716_staff_roster_and_board_account.sql), creating this index would
-- fail, so it is skipped with a notice instead. Remove the extra staff
-- accounts and re-run this block to add it.
do $$
begin
  if (select count(*) from public.profiles where role = 'staff') <= 1 then
    create unique index if not exists profiles_single_staff_role
      on public.profiles (role)
      where role = 'staff';
  else
    raise notice 'More than one staff-role profile exists; profiles_single_staff_role not created. Remove the extra staff accounts and re-run.';
  end if;
end $$;
