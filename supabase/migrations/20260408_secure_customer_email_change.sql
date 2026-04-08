alter table public.profiles
add column if not exists pending_email text;

alter table public.profiles
add column if not exists email_change_requested_at timestamptz;

update public.profiles
set email = lower(trim(email))
where email is not null;

update public.profiles
set pending_email = lower(trim(pending_email))
where pending_email is not null;

create unique index if not exists profiles_email_unique_ci
on public.profiles (lower(email))
where email is not null;

create unique index if not exists profiles_pending_email_unique_ci
on public.profiles (lower(pending_email))
where pending_email is not null;
