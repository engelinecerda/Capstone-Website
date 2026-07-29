export const PAGE_SIZE = 10;

export function getTotalPages(totalItems, pageSize = PAGE_SIZE) {
  return Math.max(1, Math.ceil(totalItems / pageSize));
}

export function paginate(items, page, pageSize = PAGE_SIZE) {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

function buildPageList(current, total) {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const keep = new Set([1, total, current - 1, current, current + 1]);
  const sorted = Array.from(keep).filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const result = [];
  let prev = null;
  for (const page of sorted) {
    if (prev !== null && page - prev > 1) result.push('...');
    result.push(page);
    prev = page;
  }
  return result;
}

export function renderPagination(container, { totalItems, currentPage, pageSize = PAGE_SIZE, onPageChange }) {
  if (!container) return;

  if (!totalItems) {
    container.innerHTML = '';
    return;
  }

  const totalPages = getTotalPages(totalItems, pageSize);
  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalItems);
  const pageList = buildPageList(currentPage, totalPages);

  container.innerHTML = `
    <p class="pagination-summary">Showing ${start}&ndash;${end} of ${totalItems}</p>
    <div class="pagination-controls">
      <button type="button" class="page-btn page-chevron" data-page="prev" ${currentPage === 1 ? 'disabled' : ''} aria-label="Previous page">&lsaquo;</button>
      ${pageList.map((p) => p === '...'
        ? '<span class="page-ellipsis">&hellip;</span>'
        : `<button type="button" class="page-btn${p === currentPage ? ' active' : ''}" data-page="${p}" ${p === currentPage ? 'aria-current="page"' : ''}>${p}</button>`
      ).join('')}
      <button type="button" class="page-btn page-chevron" data-page="next" ${currentPage === totalPages ? 'disabled' : ''} aria-label="Next page">&rsaquo;</button>
    </div>
  `;

  container.querySelectorAll('.page-btn:not([disabled])').forEach((btn) => {
    btn.addEventListener('click', () => {
      const raw = btn.dataset.page;
      const nextPage = raw === 'prev' ? currentPage - 1 : raw === 'next' ? currentPage + 1 : Number(raw);
      onPageChange(nextPage);
    });
  });
}
