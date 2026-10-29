-- Normalize entity categories used by the Audit Trail filter.
-- Canonical names are lowercase singular: account, contract, payment,
-- reservation. Existing audit details and identifiers are unchanged.
update public.audit_log
   set category = case lower(category)
     when 'account' then 'account'
     when 'accounts' then 'account'
     when 'contract' then 'contract'
     when 'contracts' then 'contract'
     when 'payment' then 'payment'
     when 'payments' then 'payment'
     when 'reservation' then 'reservation'
     when 'reservations' then 'reservation'
     else category
   end
 where lower(category) in ('account', 'accounts', 'contract', 'contracts', 'payment', 'payments', 'reservation', 'reservations');

notify pgrst, 'reload schema';
