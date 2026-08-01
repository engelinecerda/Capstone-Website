// reservation_form_config.js
// Customer-facing loader for admin-configurable reservation-form content
// (system_settings keys: reservation_form_fields, terms_and_conditions,
// data_privacy_policy — all edited from admin/config/form.html).
//
// Every failure mode here (network error, missing row, malformed JSON,
// empty body) resolves to "use the caller's existing hardcoded default" —
// this must never block or break the booking flow, and the hardcoded
// POLICY_CONTENT in reservations.html is deliberately left in place as
// that fallback rather than being deleted.

const DEFAULT_FIELD_RULES = { contact_phone_required: true, special_requests_required: false };

// Mirrors the parser used on the admin preview side (see parsePolicyBody in
// js/admin_reservation_form_config.js) so admin and customer render the
// same saved text the same way. Blank-line-separated blocks; a short first
// line with no trailing period becomes the section heading; lines starting
// with "- " become bullets.
function parsePolicyBody(text) {
  const blocks = String(text || '').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    let heading = '';
    if (lines.length && lines[0].length < 80 && !lines[0].endsWith('.') && !lines[0].startsWith('- ')) {
      heading = lines.shift();
    }
    const paragraphs = [];
    const bullets = [];
    lines.forEach((l) => {
      if (l.startsWith('- ')) bullets.push(l.slice(2).trim());
      else paragraphs.push(l);
    });
    return { heading, paragraphs, bullets };
  });
}

// Canonical loader for the standalone /terms-and-conditions.html page. The
// booking-flow agreement modal above uses loadReservationFormConfig (which
// silently falls back to POLICY_CONTENT on any failure — appropriate mid-
// booking, where the flow must never block). This page is meant to be
// authoritative and bookmarkable, so it needs to tell "not configured yet"
// apart from "failed to load": returns null when the row is simply missing
// (caller can show its own default copy) but *throws* on a real fetch/DB
// error so the caller can show a retry state instead of silently serving
// possibly-stale text.
export async function loadTermsDocument(supabase) {
  const { data, error } = await supabase
    .from('system_settings')
    .select('setting_value, updated_at')
    .eq('setting_key', 'terms_and_conditions')
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const parsed = JSON.parse(data.setting_value);
  return { body: parsed.body || '', updatedAt: data.updated_at };
}

// Canonical loader for the standalone /privacy-policy.html page. Same
// "null when unconfigured, throw on real failure" contract as
// loadTermsDocument above — see that function's comment for why.
export async function loadPrivacyPolicyDocument(supabase) {
  const { data, error } = await supabase
    .from('system_settings')
    .select('setting_value, updated_at')
    .eq('setting_key', 'data_privacy_policy')
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const parsed = JSON.parse(data.setting_value);
  return { body: parsed.body || '', updatedAt: data.updated_at };
}

export async function loadReservationFormConfig(supabase) {
  const result = { fieldRules: { ...DEFAULT_FIELD_RULES }, policyOverrides: {} };

  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('setting_key, setting_value')
      .in('setting_key', ['reservation_form_fields', 'terms_and_conditions', 'data_privacy_policy']);

    if (error || !data) return result;

    data.forEach((row) => {
      try {
        const parsed = JSON.parse(row.setting_value);
        if (row.setting_key === 'reservation_form_fields') {
          result.fieldRules = { ...DEFAULT_FIELD_RULES, ...parsed };
        } else if (row.setting_key === 'terms_and_conditions' && parsed.body?.trim()) {
          result.policyOverrides.terms = { title: 'Terms & Conditions', sections: parsePolicyBody(parsed.body) };
        } else if (row.setting_key === 'data_privacy_policy' && parsed.body?.trim()) {
          result.policyOverrides.privacy = { title: 'Data Privacy Policy', sections: parsePolicyBody(parsed.body) };
        }
      } catch {
        // Malformed row for this key — skip it, caller's default/fallback stands.
      }
    });
  } catch {
    // Network/DB failure — defaults only, caller's hardcoded fallback stands.
  }

  return result;
}
