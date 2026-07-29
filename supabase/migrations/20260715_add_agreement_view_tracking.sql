-- Records evidence that the customer actually looked at the service
-- agreement before signing (Review & Sign step full-screen reader). Written
-- by the generate-signed-contract edge function (service role) alongside
-- the rest of the signature record — no RLS changes needed, matching the
-- existing "only the service role writes here" pattern for this table.

alter table public.contract_signatures
  add column if not exists agreement_view_method text
    check (agreement_view_method in ('scrolled_inline', 'opened_full_view'));

alter table public.contract_signatures
  add column if not exists agreement_viewed_at timestamptz;
