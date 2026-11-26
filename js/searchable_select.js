// Turns a native <select> into a type-to-search dropdown.
//
// The <select> stays in the page (hidden) as the source of truth, so existing
// code that reads `select.value`, listens for its "change" event, or rebuilds
// its <option>s keeps working untouched: picking an item sets select.value
// and fires a real "change" event, and a MutationObserver re-syncs the visible
// box whenever the options are replaced.
//
// Usage: makeSelectSearchable(document.getElementById('cateringPackageSelect'));

export function makeSelectSearchable(select, { placeholder = 'Search…', noResults = 'No matches' } = {}) {
  if (!select || select.dataset.searchable === '1') return null;
  select.dataset.searchable = '1';

  const wrap = document.createElement('div');
  wrap.className = 'ss-wrap';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'modal-input ss-input';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = placeholder;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');
  const list = document.createElement('ul');
  list.className = 'ss-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  const chevron = document.createElement('i');
  chevron.className = 'ti ti-chevron-down ss-chevron';
  chevron.setAttribute('aria-hidden', 'true');

  select.insertAdjacentElement('afterend', wrap);
  wrap.append(input, chevron, list);
  select.hidden = true;

  let open = false;
  let active = -1;
  let shown = [];

  const options = () => Array.from(select.options).filter((o) => o.value !== '');
  const selectedLabel = () => select.selectedOptions[0]?.textContent.trim() || '';

  function syncInput() { input.value = selectedLabel(); }

  function render(query = '') {
    const q = query.trim().toLowerCase();
    shown = options().filter((o) => !q || o.textContent.toLowerCase().includes(q));
    list.innerHTML = '';
    if (!shown.length) {
      const li = document.createElement('li');
      li.className = 'ss-empty';
      li.textContent = noResults;
      list.appendChild(li);
      active = -1;
      return;
    }
    shown.forEach((o, i) => {
      const li = document.createElement('li');
      li.className = 'ss-option' + (o.value === select.value ? ' selected' : '');
      li.setAttribute('role', 'option');
      li.dataset.index = String(i);
      li.textContent = o.textContent.trim();
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
      list.appendChild(li);
    });
    active = Math.max(0, shown.findIndex((o) => o.value === select.value));
    if (!q) setActive(active, true); else setActive(0, true);
  }

  function setActive(i, scroll) {
    active = i;
    Array.from(list.querySelectorAll('.ss-option')).forEach((li, idx) => li.classList.toggle('active', idx === i));
    if (scroll) list.querySelector('.ss-option.active')?.scrollIntoView({ block: 'nearest' });
  }

  function openList(query = '') {
    open = true;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    render(query);
  }

  function closeList() {
    open = false;
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    syncInput();
  }

  function choose(i) {
    const o = shown[i];
    if (!o) return;
    const changed = select.value !== o.value;
    select.value = o.value;
    closeList();
    input.blur();
    if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  input.addEventListener('focus', () => { input.select(); openList(''); });
  input.addEventListener('click', () => { if (!open) { input.select(); openList(''); } });
  input.addEventListener('input', () => { if (!open) openList(input.value); else render(input.value); });
  input.addEventListener('blur', () => closeList());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) openList(''); else if (shown.length) setActive(Math.min(shown.length - 1, active + 1), true);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (open && shown.length) setActive(Math.max(0, active - 1), true);
    } else if (e.key === 'Enter') {
      if (open) { e.preventDefault(); choose(active); }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); closeList(); input.blur(); }
    }
  });
  chevron.addEventListener('mousedown', (e) => { e.preventDefault(); if (open) { closeList(); input.blur(); } else input.focus(); });

  // Options are rebuilt by the page's own code (innerHTML): keep the visible
  // box in step with whatever is now selected.
  new MutationObserver(() => { if (!open) syncInput(); }).observe(select, { childList: true, subtree: true, attributes: true });
  select.addEventListener('change', () => { if (!open) syncInput(); });

  syncInput();
  return { refresh: syncInput };
}
