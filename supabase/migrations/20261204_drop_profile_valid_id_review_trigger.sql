-- Valid ID: drop the profile-based review trigger.
--
-- The valid ID flow follows the customer-ids bucket + valid_id_review design
-- (20261128, 20261201, 20261202). An earlier, separate attempt
-- (20261111_customer_valid_id_review / 20261126_valid_id_uploaded_at_and_owner_view,
-- both removed from the repo) added a BEFORE INSERT/UPDATE trigger on profiles
-- that overwrote valid_id_uploaded_at on every customer update. Left in place,
-- it stops My Profile and the booking form from recording a saved ID.
--
-- Safe to run whether or not those migrations were ever applied. The unused
-- profiles.valid_id_* columns, valid_id_review_logs table and
-- customer-valid-ids bucket are left alone (no data is dropped).

drop trigger if exists reset_valid_id_review_on_upload on public.profiles;
drop function if exists public.reset_valid_id_review_on_upload();

notify pgrst, 'reload schema';
