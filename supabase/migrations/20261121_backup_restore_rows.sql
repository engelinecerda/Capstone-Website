-- Restore a backup table inside the database, so it can be put back as it was.
--
-- Why: the in-app restore used to upsert through the REST API as the signed-in
-- admin. That replays every row through the rules meant for NEW customer
-- actions, so a restore of history could not work:
--   * reservations: "This date is too soon" (past events fail the advance-notice
--     rule), plus the capacity, price and guest-count checks;
--   * reschedule_requests / reservation_extensions: "no longer eligible" /
--     "not yet eligible" (the parent reservation is completed or cancelled);
--   * updated_at: BEFORE UPDATE triggers stamp now() over the restored value on
--     every row that already exists (venue, payment_type, announcement,
--     catering_dish_category, catering_section_rule, and reservations whenever
--     anything else about the row differs);
--   * eleven tables the admin role can read but not write (payment, receipts,
--     reservation_contracts, contract_signatures, reviews, ...).
--
-- What this does: backup_restore_rows(table, rows, conflict_target) upserts one
-- batch as a SECURITY DEFINER function (so table permissions don't apply) and,
-- for that batch only, switches the table's user triggers off, so the rows go
-- back exactly as saved: nothing re-validated, no updated_at re-stamped, no
-- notification or audit rows generated. Foreign keys stay enforced (they are
-- internal triggers, which DISABLE TRIGGER USER leaves alone), so the restore
-- order in js/admin_backup_tables.js still matters.
--
-- Safety:
--   * admin role only (same check as backup_resync_sequences);
--   * only the tables listed below — KEEP THIS LIST IN SYNC with
--     BACKUP_TABLE_CONFIG in js/admin_backup_tables.js (tables marked
--     restore:false are deliberately left out);
--   * the conflict columns must be real columns of that table;
--   * triggers are switched off and back on inside one transaction, so an error
--     rolls the whole batch back and leaves the triggers on.
-- Only the columns present in the saved rows are written, so an older backup
-- never blanks a newer column. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.backup_restore_rows(
  p_table    text,
  p_rows     jsonb,
  p_conflict text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowed  text[] := array[
    'profiles',
    'staff_roster',
    'package_category',
    'package',
    'package_tier',
    'venue',
    'package_venue',
    'package_photo',
    'badge',
    'package_badge',
    'package_discount',
    'catering_dish_category',
    'catering_dish',
    'catering_section_rule',
    'contract_templates',
    'contract_template_clause',
    'contract_locked_clause',
    'contract_field',
    'event_types',
    'payment_type',
    'payment_method',
    'system_settings',
    'operating_hours',
    'scheduling_settings',
    'scope_capacity',
    'venue_capacity',
    'calendar_blackouts',
    'notification_trigger',
    'notification_template',
    'page_header',
    'gallery_image',
    'about_section',
    'about_value',
    'faq',
    'business_location',
    'business_contact',
    'business_social_link',
    'referral_sources',
    'landing_service',
    'menu_section',
    'menu_banner',
    'announcement',
    'reservations',
    'reservation_contracts',
    'contract_signatures',
    'reservation_staff_assignments',
    'reservation_status',
    'reschedule_requests',
    'payment',
    'reservation_extensions',
    'reservation_additional_head_requests',
    'receipts',
    'reservation_charges',
    'reservation_cancellations',
    'reviews',
    'reservation_forecast'
  ];
  v_oid      regclass;
  v_cols     text[];
  v_conflict text[];
  v_update   text[];
  v_action   text;
  v_sql      text;
  v_count    integer;
begin
  if public.get_my_role() is distinct from 'admin' then
    raise exception 'Only an admin can restore a backup.' using errcode = '42501';
  end if;

  if p_table is null or not (p_table = any(v_allowed)) then
    raise exception 'Table % is not part of the backup.', p_table using errcode = '22023';
  end if;

  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;

  v_oid := to_regclass(format('public.%I', p_table));
  if v_oid is null then
    raise exception 'Table % does not exist.', p_table using errcode = '42P01';
  end if;

  -- Columns to write: those present in the saved rows that exist on the table
  -- (computed columns excluded). A GENERATED ALWAYS identity column is NOT
  -- skipped: the insert then fails with Postgres's own message, which the
  -- restore page reports as needing 20261015_backup_restore_support.sql —
  -- better than silently giving restored rows new ids.
  select array_agg(a.attname::text order by a.attnum)
    into v_cols
  from pg_attribute a
  where a.attrelid = v_oid
    and a.attnum > 0
    and not a.attisdropped
    and a.attgenerated = ''
    and exists (select 1 from jsonb_object_keys(p_rows -> 0) k where k = a.attname::text);

  if v_cols is null then
    raise exception 'The rows for % have no known columns.', p_table using errcode = '22023';
  end if;

  v_conflict := string_to_array(replace(coalesce(p_conflict, ''), ' ', ''), ',');
  if coalesce(array_length(v_conflict, 1), 0) = 0
     or exists (select 1 from unnest(v_conflict) c where c = '' or c <> all(v_cols)) then
    raise exception 'Conflict columns (%) must be columns present in the saved rows of %.', p_conflict, p_table
      using errcode = '22023';
  end if;

  select coalesce(array_agg(c), '{}') into v_update
  from unnest(v_cols) c
  where c <> all(v_conflict);

  if cardinality(v_update) = 0 then
    v_action := 'do nothing';
  else
    select 'do update set ' || string_agg(format('%1$I = excluded.%1$I', c), ', ')
      into v_action
    from unnest(v_update) c;
  end if;

  v_sql := format(
    'insert into public.%1$I (%2$s) select %2$s from jsonb_populate_recordset(null::public.%1$I, $1) on conflict (%3$s) %4$s',
    p_table,
    (select string_agg(quote_ident(c), ', ') from unnest(v_cols) c),
    (select string_agg(quote_ident(c), ', ') from unnest(v_conflict) c),
    v_action
  );

  execute format('alter table public.%I disable trigger user', p_table);
  execute v_sql using p_rows;
  get diagnostics v_count = row_count;
  execute format('alter table public.%I enable trigger user', p_table);

  return v_count;
end;
$$;

revoke all on function public.backup_restore_rows(text, jsonb, text) from public, anon;
grant execute on function public.backup_restore_rows(text, jsonb, text) to authenticated;
