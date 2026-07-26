// policy_text.js — shared blank-line-block text parser + HTML renderer.
// Extracted from js/admin_reservation_form_config.js's Terms & Legal preview
// so the About editor's admin preview and the customer-facing About page
// render the exact same saved text the same way (same renderer, no drift).
//
// Blank-line-separated blocks; a short first line with no trailing period
// becomes a heading; lines starting with "- " become bullets.

function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function parsePolicyBody(text) {
  const blocks = String(text || '').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const isHeading = lines.length > 0 && lines[0].length < 80 && !lines[0].endsWith('.') && lines.length <= 1;
    if (isHeading) return { type: 'heading', text: lines[0] };

    const bulletLines = lines.filter((l) => l.startsWith('- '));
    if (bulletLines.length === lines.length && bulletLines.length > 0) {
      return { type: 'list', items: bulletLines.map((l) => l.slice(2).trim()) };
    }

    // Mixed block: first non-bullet line as heading if short, rest as paragraph + bullets
    const heading = lines[0].length < 80 && !lines[0].endsWith('.') ? lines.shift() : null;
    const paragraphLines = [];
    const items = [];
    lines.forEach((l) => {
      if (l.startsWith('- ')) items.push(l.slice(2).trim());
      else paragraphLines.push(l);
    });
    return { type: 'mixed', heading, paragraph: paragraphLines.join(' '), items };
  });
}

export function renderPolicyBlocks(blocks) {
  return blocks.map((block) => {
    if (block.type === 'heading') return `<h4>${escHtml(block.text)}</h4>`;
    if (block.type === 'list') return `<ul>${block.items.map((i) => `<li>${escHtml(i)}</li>`).join('')}</ul>`;
    return `
      ${block.heading ? `<h4>${escHtml(block.heading)}</h4>` : ''}
      ${block.paragraph ? `<p>${escHtml(block.paragraph)}</p>` : ''}
      ${block.items.length ? `<ul>${block.items.map((i) => `<li>${escHtml(i)}</li>`).join('')}</ul>` : ''}
    `;
  }).join('');
}

export function renderPolicyText(text) {
  return renderPolicyBlocks(parsePolicyBody(text));
}
