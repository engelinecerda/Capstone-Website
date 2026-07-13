-- Assignment acknowledgment tracking for staff schedule.
-- Staff acknowledge each assignment; if a manager later changes something
-- assignment-relevant, the acknowledgment resets so staff know to re-check.

alter table public.reservation_staff_assignments
  add column if not exists acknowledged_at timestamptz,
  add column if not exists updated_after_ack boolean not null default false,
  add column if not exists assignment_updated_at timestamptz;

-- Reset acknowledgment on all currently-acknowledged assignments for a
-- reservation when a manager changes assignment-relevant reservation details.
create or replace function public.reset_assignment_ack_on_reservation_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.reservation_staff_assignments
  set acknowledged_at = null,
      updated_after_ack = true,
      assignment_updated_at = now()
  where reservation_id = new.reservation_id
    and acknowledged_at is not null;
  return new;
end;
$$;

drop trigger if exists trg_reset_assignment_ack_on_reservation_change on public.reservations;

create trigger trg_reset_assignment_ack_on_reservation_change
after update on public.reservations
for each row
when (
  new.event_date is distinct from old.event_date
  or new.event_time is distinct from old.event_time
  or new.event_end_time is distinct from old.event_end_time
  or new.location_type is distinct from old.location_type
  or new.venue_location is distinct from old.venue_location
)
execute function public.reset_assignment_ack_on_reservation_change();

-- Reset acknowledgment when a manager edits the assignment note on an
-- already-acknowledged row.
create or replace function public.reset_assignment_ack_on_note_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.acknowledged_at := null;
  new.updated_after_ack := true;
  new.assignment_updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_reset_assignment_ack_on_note_change on public.reservation_staff_assignments;

create trigger trg_reset_assignment_ack_on_note_change
before update on public.reservation_staff_assignments
for each row
when (
  new.assignment_note is distinct from old.assignment_note
  and old.acknowledged_at is not null
)
execute function public.reset_assignment_ack_on_note_change();

-- Staff-callable acknowledgment. SECURITY DEFINER lets staff flip these two
-- columns on their own row without needing a broader UPDATE RLS policy on
-- this table (they only ever have SELECT on their own assignments).
create or replace function public.acknowledge_staff_assignment(p_assignment_id bigint)
returns public.reservation_staff_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_row public.reservation_staff_assignments;
begin
  if public.get_my_role() <> 'staff' then
    raise exception 'Only staff accounts can acknowledge assignments.';
  end if;

  update public.reservation_staff_assignments
  set acknowledged_at = now(),
      updated_after_ack = false
  where assignment_id = p_assignment_id
    and staff_user_id = auth.uid()
  returning * into updated_row;

  if updated_row.assignment_id is null then
    raise exception 'Assignment not found or not owned by current user.';
  end if;

  return updated_row;
end;
$$;

grant execute on function public.acknowledge_staff_assignment(bigint) to authenticated;
