// password_rules.js — shared client-side mirror of Supabase Auth's
// configured password policy (Authentication > Providers > Email > Password
// Requirements: lowercase, uppercase, special character, min 8 characters).
// Used by both signup and the customer profile's "Change Password" form so
// a weak password is rejected with a specific reason immediately, instead
// of round-tripping to Supabase first for a generic error.
export const PASSWORD_HINT = 'Must be at least 8 characters and include an uppercase letter, a lowercase letter, and a special character.';

// Per-criterion pass/fail, for pages that show a live requirements
// checklist (e.g. the super admin "edit account" security tab) instead
// of — or in addition to — a single blocking error message.
export function getPasswordChecks(password) {
  const pw = password || '';
  return {
    length: pw.length >= 8,
    lowercase: /[a-z]/.test(pw),
    uppercase: /[A-Z]/.test(pw),
    special: /[^A-Za-z0-9]/.test(pw),
  };
}

// Returns '' when the password satisfies every rule, otherwise the first
// unmet requirement's message.
export function validatePassword(password) {
  const checks = getPasswordChecks(password);
  if (!checks.length) return 'Password must be at least 8 characters long.';
  if (!checks.lowercase) return 'Password must include at least one lowercase letter.';
  if (!checks.uppercase) return 'Password must include at least one uppercase letter.';
  if (!checks.special) return 'Password must include at least one special character.';
  return '';
}