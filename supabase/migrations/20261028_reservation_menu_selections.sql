-- Persist the dishes/drinks a customer picks in the catering dish builder.
--
-- Before: the builder's cart (S.cateringCart in js/reservations.js) was used
-- only for pricing and the on-screen summary, then discarded — the
-- reservations insert had no menu field, so neither the customer's
-- reservation-details page nor the admin's could show what was selected.
--
-- After: the submit step stores the picks here as a JSON array of
--   { "category": "Main Dish", "dish": "Chicken ...", "pax": 20 }
-- (pax is the tray size / Pax Count the dish was ordered for, or null).
-- total_price remains the pricing authority; prices are deliberately not
-- duplicated in this column.
--
-- Nullable with no default: reservations made before this migration (and
-- packages without a dish builder) simply have no stored selections.
-- Existing grants/RLS are table-level, so no policy changes are needed.

alter table public.reservations
  add column if not exists menu_selections jsonb;

comment on column public.reservations.menu_selections is
  'Catering dish-builder picks at booking time: [{category, dish, pax}]. Null when the package has no dish builder or the reservation predates this column.';
