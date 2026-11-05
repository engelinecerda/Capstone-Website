-- Review moderation is a manager task. Admins keep read access to reviews
-- (get_admin_reviews_page / get_admin_review_stats are unchanged) but can no
-- longer hide or restore them. The admin UI is view-only to match.
create or replace function public.moderate_review(p_review_id uuid, p_hidden boolean, p_reason text)
returns boolean language plpgsql security definer set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_review public.reviews%rowtype;
  v_reason text := nullif(btrim(left(coalesce(p_reason, ''), 500)), '');
begin
  select * into v_actor from public.profiles where user_id = auth.uid() and role = 'manager';
  if v_actor.user_id is null then raise exception 'Only managers can moderate reviews.'; end if;
  if v_reason is null then raise exception 'A moderation reason is required.'; end if;
  update public.reviews
     set is_hidden = coalesce(p_hidden, false),
         moderation_reason = v_reason,
         moderated_by = auth.uid(), moderated_at = now()
   where review_id = p_review_id returning * into v_review;
  if v_review.review_id is null then raise exception 'Review not found.'; end if;
  insert into public.audit_log(user_id, user_name, user_role, action, category, details, entity_id)
  values (auth.uid(), trim(concat_ws(' ', v_actor.first_name, v_actor.last_name)), v_actor.role,
          case when v_review.is_hidden then 'Hid Review' else 'Unhid Review' end,
          'review', v_reason, v_review.review_id::text);
  return v_review.is_hidden;
end;
$$;
revoke all on function public.moderate_review(uuid, boolean, text) from public, anon;
grant execute on function public.moderate_review(uuid, boolean, text) to authenticated;

notify pgrst, 'reload schema';
