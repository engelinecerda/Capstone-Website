-- Fixes the root cause behind "Signature check: not yet scanned" appearing
-- on every reservation, regardless of contract content: the auto-verify
-- contract trigger (auto_verify_contract_on_upload(), see
-- 20260819_contract_verification_fixes.sql / 20260825_remove_contract_
-- resubmission.sql) reads two settings before calling verify-contract via
-- pg_net — the project URL and the service_role key.
--
-- Original attempt at this migration used `alter database postgres set
-- app.settings.*`, following the pattern the trigger function already
-- expected (current_setting('app.settings...')). That failed on Supabase's
-- hosted platform with "permission denied to set parameter" — ALTER
-- DATABASE ... SET requires ownership of the database object, which
-- Supabase's shared infrastructure retains; project owners don't get it
-- even via the SQL Editor's postgres role. That's very likely why these
-- settings were never configured in the first place.
--
-- Fix: store the two values in an ordinary table instead of a database-level
-- GUC, in its own schema (never exposed by the API — PostgREST only serves
-- the 'public'/'graphql_public' schemas by default) and update the trigger
-- function to read from that table instead of current_setting(). No
-- elevated privileges needed — CREATE SCHEMA/TABLE and INSERT are normal
-- project-owner operations.
--
-- Run this once in the Supabase SQL Editor with YOUR project's actual
-- service_role (or "default" secret key, on the newer key-naming UI)
-- substituted below (Project Settings → API Keys). That key is a secret —
-- never commit the filled-in version of this file; run it directly in the
-- SQL Editor and leave the placeholder in git.
-- ─────────────────────────────────────────────────────────────────────────────

create schema if not exists app_config;

create table if not exists app_config.settings (
  key   text primary key,
  value text not null
);

revoke all on app_config.settings from public, anon, authenticated;

-- Belt-and-suspenders: RLS with zero policies means anon/authenticated get
-- nothing even if this schema were ever exposed via the API in the future.
-- The trigger function still reads it fine — it's SECURITY DEFINER owned by
-- postgres, which (like service_role) bypasses RLS entirely.
alter table app_config.settings enable row level security;

insert into app_config.settings (key, value) values
  ('supabase_url', 'https://gznemevovvcfjnuwsixl.supabase.co'),
  ('service_role_key', '<PASTE_SERVICE_ROLE_KEY_HERE>')
on conflict (key) do update set value = excluded.value;

create or replace function auto_verify_contract_on_upload()
returns trigger
language plpgsql
security definer
as $$
declare
  v_supabase_url  text;
  v_service_key   text;
  v_is_new_upload boolean;
begin
  if TG_OP = 'INSERT' then
    v_is_new_upload := NEW.contract_url is not null;
  else
    v_is_new_upload := NEW.contract_url is not null and OLD.contract_url is null;
  end if;

  if not v_is_new_upload then
    return NEW;
  end if;

  select value into v_supabase_url from app_config.settings where key = 'supabase_url';
  select value into v_service_key  from app_config.settings where key = 'service_role_key';

  if v_supabase_url is null or v_supabase_url = ''
     or v_service_key is null or v_service_key = '' then
    raise warning
      'auto_verify_contract: app_config.settings not configured — skipping auto-verify for reservation %',
      NEW.reservation_id;
    return NEW;
  end if;

  perform pg_net.http_post(
    url     := v_supabase_url || '/functions/v1/verify-contract',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body    := jsonb_build_object(
      'reservation_id', NEW.reservation_id,
      'contract_url',   NEW.contract_url,
      'page_count',     NEW.page_count
    )::text
  );

  return NEW;
end;
$$;

-- Trigger definition itself is unchanged — only the function body above
-- changed, so no DROP/CREATE TRIGGER needed here.

-- Verify with (run as a separate query, after filling in and running the
-- INSERT above):
--   select key, length(value) from app_config.settings;
