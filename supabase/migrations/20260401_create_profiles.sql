create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  first_name text not null,
  middle_name text,
  last_name text not null,
  email text not null,
  pending_email text,
  email_change_requested_at timestamptz,
  phone_number text,
  role text default 'customer',
  date_registered timestamptz default now()
);

alter table public.profiles enable row level security;

drop policy if exists "select own profile" on public.profiles;
create policy "select own profile"
  on public.profiles for select
  using (auth.uid() = user_id);

drop policy if exists "insert own profile" on public.profiles;
create policy "insert own profile"
  on public.profiles for insert
  with check (auth.uid() = user_id);

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile"
  on public.profiles for update
  using (auth.uid() = user_id);

drop policy if exists "admin read all profiles" on public.profiles;
create policy "admin read all profiles"
  on public.profiles for select
  using (
    exists (
      select 1
      from public.profiles p
      where p.user_id = auth.uid()
        and p.role = 'admin'
    )
  );

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    user_id,
    first_name,
    middle_name,
    last_name,
    email,
    pending_email,
    email_change_requested_at,
    phone_number,
    role,
    date_registered
  )
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'first_name', ''),
    nullif(new.raw_user_meta_data->>'middle_name', ''),
    coalesce(new.raw_user_meta_data->>'last_name', ''),
    lower(trim(new.email)),
    null,
    null,
    nullif(new.raw_user_meta_data->>'phone_number', ''),
    coalesce(new.raw_user_meta_data->>'role', 'customer'),
    now()
  )
  on conflict (user_id) do update
  set first_name = excluded.first_name,
      middle_name = excluded.middle_name,
      last_name = excluded.last_name,
      email = excluded.email,
      phone_number = excluded.phone_number,
      role = excluded.role;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
