import { next } from '@vercel/edge';
import { buildMaintenancePageHtml } from './js/maintenance_template.js';

// ── PART 1: outer gate in front of the real Supabase-backed admin/staff
// login. Blocks unauthenticated requests from ever reaching the management
// portal's HTML/JS/CSS (search engines, admin-panel scanners, casual
// URL-guessers). This is NOT the real access-control boundary — that's
// still Supabase RLS plus validateAdminSession() on every page. This
// middleware only decides whether a browser gets to see the login screen
// at all. Unchanged by the maintenance-mode gate added below.
//
// ── PART 2: Maintenance Mode (Maintenance module, Part C) — the customer
// surface only. Supabase sessions live in localStorage, not cookies, so
// this middleware can't tell whether a browser is logged in as staff — it
// doesn't need to: staff/admin/board already live under their own URL
// namespace (gated by PART 1 above, untouched), so gating everything else
// by literal path is sufficient and can't be bypassed by typing a customer
// URL directly, since the check runs before any response is sent.
const CUSTOMER_PATHS = new Set([
  '/', '/about', '/menu', '/faqs', '/packages', '/reservations', '/reviews',
  '/account', '/payment', '/reservation-details', '/login', '/signup',
  '/forgot-password', '/reset-password', '/terms-and-conditions',
]);

// Same public project URL/anon key already embedded in js/supabase.js —
// not a secret, safe to reuse here for an anonymous, public-read request.
const SUPABASE_URL = 'https://gznemevovvcfjnuwsixl.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_CeGNCGlslM9tB2WD7Vrlvw_Da--_DIM';

export const config = {
  matcher: [
    '/admin', '/admin/:path*', '/board', '/board/:path*',
    '/', '/about', '/menu', '/faqs', '/packages', '/reservations', '/reviews',
    '/account', '/payment', '/reservation-details', '/login', '/signup',
    '/forgot-password', '/reset-password', '/terms-and-conditions',
  ],
};

function isAuthorized(request) {
  const expectedUser = process.env.ADMIN_GATE_USER;
  const expectedPass = process.env.ADMIN_GATE_PASS;

  // Fail closed: if the gate credentials aren't configured for this
  // environment, deny rather than silently letting everyone through.
  if (!expectedUser || !expectedPass) return false;

  const authHeader = request.headers.get('authorization') || '';
  if (!authHeader.startsWith('Basic ')) return false;

  let decoded;
  try {
    decoded = atob(authHeader.slice('Basic '.length));
  } catch {
    return false;
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) return false;

  const user = decoded.slice(0, separatorIndex);
  const pass = decoded.slice(separatorIndex + 1);
  return user === expectedUser && pass === expectedPass;
}

// Small, short-timeout read — fails OPEN (returns null) on any error or
// timeout, so a Supabase hiccup never takes the whole customer site down.
async function fetchJsonRow(path, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0] ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default async function middleware(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  // PART 1 — staff/admin/board surface, byte-for-byte unchanged.
  if (path === '/admin' || path.startsWith('/admin/') || path === '/board' || path.startsWith('/board/')) {
    if (isAuthorized(request)) {
      return next();
    }
    return new Response('Authentication required.', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="ELI Coffee Events Management Portal", charset="UTF-8"',
      },
    });
  }

  // PART 2 — customer surface only.
  if (!CUSTOMER_PATHS.has(path)) {
    return next();
  }

  const mode = await fetchJsonRow('maintenance_mode?select=is_on,title,message&id=eq.true');
  if (!mode || !mode.is_on) {
    return next();
  }

  const contact = await fetchJsonRow('business_contact?select=brand_name,logo_url&id=eq.true');

  const html = buildMaintenancePageHtml({
    title: mode.title,
    message: mode.message,
    brandName: contact?.brand_name,
    logoUrl: contact?.logo_url,
  });

  return new Response(html, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'Retry-After': '3600',
    },
  });
}
