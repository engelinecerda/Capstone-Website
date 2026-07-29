// js/admin_placeholder.js
// Shared "not yet implemented" page body for admin nav destinations that
// don't have real content yet. Call initPlaceholder({ title, description })
// after the page's own validateAdminSession() succeeds.
export function initPlaceholder({ title, description }) {
  const titleEl = document.getElementById('placeholderTitle');
  const descEl = document.getElementById('placeholderDesc');
  if (titleEl) titleEl.textContent = title;
  if (descEl) descEl.textContent = description;
  document.title = `${title} - ELI Coffee Events`;
}
