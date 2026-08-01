// maintenance_template.js — the single source of truth for what a customer
// sees when the site is in maintenance mode. Deliberately isomorphic: no
// DOM, no Node APIs, no imports — it runs both in the browser (the admin's
// live preview, js/admin_maintenance_mode.js) and in Vercel's Edge runtime
// (middleware.js), so what the admin previews is exactly what ships.
// Styled inline (no external stylesheet) so the 503 response is fully
// self-contained — no second asset fetch needed to render correctly.

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

export function buildMaintenancePageHtml({ title, message, brandName }) {
  const safeTitle = escapeHtml(title || "We'll be right back");
  const safeMessage = escapeHtml(message || 'The site is briefly down for scheduled maintenance. Please check back soon.');
  const safeBrand = escapeHtml(brandName || 'ELI Coffee Events');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeTitle} — ${safeBrand}</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #FAF8F4; color: #1E0D04; font-family: 'Inter', system-ui, sans-serif;
    padding: 24px; text-align: center; line-height: 1.6;
  }
  .card { max-width: 480px; }
  .brand { font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: #6B3820; margin: 0 0 18px; }
  h1 { font-size: 26px; font-weight: 600; margin: 0 0 12px; color: #1E0D04; }
  p.message { font-size: 15px; color: #5A3420; margin: 0 0 22px; }
  .icon { color: #6B3820; margin-bottom: 18px; }
  .hint { font-size: 12.5px; color: #9E7558; }
</style>
</head>
<body>
  <main class="card">
    <p class="brand">${safeBrand}</p>
    <div class="icon" aria-hidden="true">
      <svg width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/>
      </svg>
    </div>
    <h1>${safeTitle}</h1>
    <p class="message">${safeMessage}</p>
    <p class="hint">If you were in the middle of a booking or payment, your details are safe — nothing was lost. Please return shortly.</p>
  </main>
</body>
</html>`;
}
