-- ═══════════════════════════════════════════════════════════════════════════
-- Month calendar availability: do less work per request
--
-- get_booking_calendar_availability() answers a whole month grid (42 days) by
-- running the full time-slot check for every day and every scope — about 790 ms
-- for the general preview, paid again on every month change and page load.
--
-- Two cuts, same answers for everything the pages read:
--   1. Dates before today are not worked out (the pages grey them out anyway).
--   2. In the general preview (no package chosen) a date is open as soon as one
--      scope has room, so scopes after the first open one are skipped. Only
--      is_fully_booked is read in that mode; occupied_scopes is only used when
--      a package's own scope is passed, and that path is unchanged.
-- Signature, return shape and grants are the 20261115 ones. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.get_booking_calendar_availability(
  p_from_date      date,
  p_to_date        date,
  p_scope          text    default null,
  p_duration_hours integer default null,
  p_venue_id       uuid    default null
)
returns table (
  event_date      date,
  occupied_scopes text[],
  is_fully_booked boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date      date := p_from_date;
  v_scopes    text[];
  v_scope     text;
  v_occupied  text[];
  v_available boolean;
  v_duration  integer := greatest(coalesce(p_duration_hours, 1), 1);
  v_venue_id  uuid;
begin
  if p_scope is null then
    v_scopes   := array['onsite_vip', 'onsite_main_hall', 'offsite'];
    v_venue_id := null;
  else
    v_scopes   := array[p_scope];
    v_venue_id := p_venue_id;
  end if;

  while v_date <= p_to_date loop
    v_occupied := '{}'::text[];

    -- A date that has already passed can't be booked and the pages grey it out
    -- whatever this returns, so it isn't worked out. (current_date here is the
    -- server's UTC date, which is never ahead of the café's date.)
    if v_date >= current_date then
      foreach v_scope in array v_scopes loop
        select bool_or(s.is_available) into v_available
        from public.get_available_start_times(v_date, v_scope, v_duration, null, v_venue_id) s;

        if not coalesce(v_available, false) then
          v_occupied := array_append(v_occupied, v_scope);
        elsif p_scope is null then
          -- General preview: the date is open as soon as ONE scope has room,
          -- and the pages only read is_fully_booked from it, so the remaining
          -- scopes need not be checked.
          exit;
        end if;
      end loop;
    end if;

    event_date := v_date;
    occupied_scopes := v_occupied;
    is_fully_booked := (coalesce(array_length(v_occupied, 1), 0) = array_length(v_scopes, 1));
    return next;

    v_date := v_date + 1;
  end loop;
end;
$$;

grant execute on function public.get_booking_calendar_availability(date, date, text, integer, uuid) to anon, authenticated;

-- ── Verify after applying ──────────────────────────────────────────────────
--   explain analyze select * from public.get_booking_calendar_availability('2026-11-01', '2026-12-12');
--   (was ~790 ms; expect a clear drop)
--   select * from public.get_booking_calendar_availability('2026-11-24', '2026-11-28');
--   (same is_fully_booked answers as before; past dates come back empty by design)
