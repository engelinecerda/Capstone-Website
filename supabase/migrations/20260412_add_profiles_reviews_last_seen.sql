alter table public.profiles
  add column if not exists reviews_last_seen_at timestamptz;

notify pgrst, 'reload schema';
