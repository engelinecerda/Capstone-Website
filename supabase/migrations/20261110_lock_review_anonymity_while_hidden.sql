-- Prevent authors from changing public anonymity while a review is hidden
-- and under moderation. The manager can unhide it to restore that ability.
create or replace function public.set_review_anonymity(
  p_review_id uuid,
  p_is_anonymous boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_value boolean := coalesce(p_is_anonymous, false);
  v_updated integer;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to edit a review.';
  end if;

  update public.reviews
     set is_anonymous = v_value
   where review_id = p_review_id
     and user_id = auth.uid()
     and is_hidden = false;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'Review not found, not owned by current user, or under review.';
  end if;

  return v_value;
end;
$$;

revoke all on function public.set_review_anonymity(uuid, boolean) from public, anon;
grant execute on function public.set_review_anonymity(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
