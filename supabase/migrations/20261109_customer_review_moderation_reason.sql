-- Return moderation reasons only to the authenticated author of a hidden
-- review. Staff already receive reasons through the admin reviews RPC.
create or replace function public.get_my_hidden_review_reasons()
returns table (review_id uuid, moderation_reason text)
language sql
stable
security definer
set search_path = public
as $$
  select r.review_id, r.moderation_reason
    from public.reviews r
   where r.user_id = auth.uid()
     and r.is_hidden = true
   order by r.moderated_at desc nulls last, r.review_id;
$$;

revoke all on function public.get_my_hidden_review_reasons() from public, anon;
grant execute on function public.get_my_hidden_review_reasons() to authenticated;

notify pgrst, 'reload schema';
