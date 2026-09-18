// contract_render.js — shared Layer 1/2/3 contract-template data fetching.
//
// BUG-03 fix: js/reservations.js's Review & Sign step (rs7) used to select
// only `contract_templates.template_body` and merge a handful of tokens
// into it directly — it never queried contract_template_clause (Layer 2,
// admin-editable clauses), contract_locked_clause (Layer 3, e.g. the
// Electronic Signature clause), or contract_field (Layer 1, Reservation
// Summary row visibility/label/order), and never fetched the fee/terms
// values (reschedule_fee, cancellation_fee, deposit_percent,
// terms_and_conditions, data_privacy_policy) those clauses can reference
// via token. So an admin's saved edit on the Contract Template tab never
// appeared to the customer, and any of those five tokens silently rendered
// blank in the customer's preview even though the admin's own preview and
// the final signed PDF filled them in correctly — same root cause behind
// both symptoms.
//
// js/admin_contract_template.js's own live preview already queried all of
// this correctly; this module extracts that exact query shape so both
// callers use the SAME source, not two independently-written copies that
// can drift apart again. supabase/functions/generate-signed-contract/
// index.ts (the final signed PDF, the authoritative render) runs in a
// separate Deno runtime and can't import this module directly, but mirrors
// the same query shape — keep it in sync if this changes (same convention
// already used for js/merge_tokens.js's token vocabulary).

export async function fetchContractTemplateData(supabase, packageId) {
  const { data: template } = await supabase
    .from('contract_templates')
    .select('template_id, version_no, contract_type, template_body')
    .eq('package_id', packageId)
    .eq('is_active', true)
    .order('version_no', { ascending: false })
    .limit(1)
    .maybeSingle();

  let clauses = [];
  if (template?.template_id) {
    const { data: clauseRows } = await supabase
      .from('contract_template_clause')
      .select('clause_id, heading, body, sort_order')
      .eq('template_id', template.template_id)
      .order('sort_order', { ascending: true });
    clauses = clauseRows || [];
  }

  const [{ data: lockedRows }, { data: fieldRows }] = await Promise.all([
    supabase.from('contract_locked_clause').select('clause_id, key, heading, body'),
    supabase.from('contract_field').select('field_id, token, label, is_visible, sort_order').eq('section', 'summary').order('sort_order', { ascending: true }),
  ]);

  const lockedClauses = {};
  (lockedRows || []).forEach((c) => { lockedClauses[c.key] = c; });

  return { template, clauses, lockedClauses, fields: fieldRows || [] };
}

// Fee/terms token sources — same system_settings/payment_type rows the
// admin preview and the signed-PDF edge function both read live (never
// frozen except once actually snapshotted onto a submitted reservation).
export async function fetchContractFeeTermsTokens(supabase) {
  const [{ data: paymentRulesRow }, { data: downPaymentRow }, { data: termsRow }, { data: privacyRow }] = await Promise.all([
    supabase.from('system_settings').select('setting_value').eq('setting_key', 'payment_rules').maybeSingle(),
    supabase.from('payment_type').select('percent_of_total').eq('code', 'down_payment').maybeSingle(),
    supabase.from('system_settings').select('setting_value').eq('setting_key', 'terms_and_conditions').maybeSingle(),
    supabase.from('system_settings').select('setting_value').eq('setting_key', 'data_privacy_policy').maybeSingle(),
  ]);

  let paymentRules = {};
  try { paymentRules = paymentRulesRow?.setting_value ? JSON.parse(paymentRulesRow.setting_value) : {}; } catch { /* defaults below */ }
  let termsBody = '';
  try { termsBody = termsRow?.setting_value ? (JSON.parse(termsRow.setting_value).body || '') : ''; } catch { /* leave blank */ }
  let privacyBody = '';
  try { privacyBody = privacyRow?.setting_value ? (JSON.parse(privacyRow.setting_value).body || '') : ''; } catch { /* leave blank */ }

  return {
    rescheduleFee: Number(paymentRules.reschedule_fee ?? 3000),
    cancellationFeeOnsite: Number(paymentRules.cancellation_fee_onsite ?? 500),
    cancellationFeeOffsite: Number(paymentRules.cancellation_fee_offsite ?? 2000),
    depositPercent: downPaymentRow?.percent_of_total ?? 50,
    termsAndConditions: termsBody,
    dataPrivacyPolicy: privacyBody,
  };
}
