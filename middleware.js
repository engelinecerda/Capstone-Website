import { next } from '@vercel/edge';

// Extra outer gate in front of the real Supabase-backed admin/staff login.
// Blocks unauthenticated requests from ever reaching the management portal's
// HTML/JS/CSS (search engines, admin-panel scanners, casual URL-guessers).
// This is NOT the real access-control boundary — that's still Supabase RLS
// plus validateAdminSession() on every page. This middleware only decides
// whether a browser gets to see the login screen at all.
export const config = {
  matcher: ['/admin', '/admin/:path*', '/board', '/board/:path*'],
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

export default function middleware(request) {
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
