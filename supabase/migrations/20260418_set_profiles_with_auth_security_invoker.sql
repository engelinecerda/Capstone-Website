do $$
begin
  if current_setting('server_version_num')::integer < 150000 then
    raise notice 'Skipping public.profiles_with_auth security_invoker update because Postgres is below version 15.';
    return;
  end if;

  if exists (
    select 1
    from pg_views
    where schemaname = 'public'
      and viewname = 'profiles_with_auth'
  ) then
    execute 'alter view public.profiles_with_auth set (security_invoker = true)';
  else
    raise notice 'Skipping public.profiles_with_auth security_invoker update because the view does not exist.';
  end if;
end
$$;
