// password_rules.js — shared client-side mirror of Supabase Auth's
// configured password policy (Authentication > Providers > Email > Password
// Requirements: lowercase, uppercase, special character, min 8 characters).
// Used by both signup and the customer profile's "Change Password" form so
// a weak password is rejected with a specific reason immediately, instead
// of round-tripping to Supabase first for a generic error.
export const PASSWORD_HINT = 'Must be at least 8 characters and include an uppercase letter, a lowercase letter, and a special character.';

// Returns '' when the password satisfies every rule, otherwise the first
// unmet requirement's message.
export function validatePassword(password) {
  if (!password || password.length < 8) return 'Password must be at least 8 characters long.';
  if (!/[a-z]/.test(password)) return 'Password must include at least one lowercase letter.';
  if (!/[A-Z]/.test(password)) return 'Password must include at least one uppercase letter.';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must include at least one special character.';
  return '';
}
