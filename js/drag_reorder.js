/**
 * drag_reorder.js — drag-to-reorder for lists and table bodies. No library.
 *
 * Uses Pointer Events, so one code path covers mouse, touch and pen.
 *
 *   enableDragReorder({
 *     container,                   // element that holds the rows (a <tbody>, a list <div>)
 *     rowSelector: '.inc-row',     // one match per reorderable row, in DOM order
 *     handleSelector: '.drag-handle',
 *     layout: 'vertical',          // or 'grid' for cards that wrap onto several lines
 *     onReorder: (fromIndex, toIndex) => { ... },
 *   });
 *
 * The helper never moves DOM nodes itself. It reports the final indexes and
 * the caller reorders its data and re-renders, so the screen can never drift
 * from the data. Listeners sit on `container`, so they survive re-renders.
 *
 * While a handle is focused, ArrowUp / ArrowDown also move the row (and
 * ArrowLeft / ArrowRight in a grid). Dragging needs a pointer, so this keeps a
 * keyboard route with no visible arrow buttons.
 *
 * Styling hooks (see css/super_admin_packages.css):
 *   .is-dragging  the row being dragged
 *   .drop-before / .drop-after  the line showing where it will land
 *   body.is-drag-reordering  set during a drag (grabbing cursor, no text selection)
 */

const EDGE_PX = 48;        // distance from a scroll edge where auto-scroll starts
const MAX_SCROLL_STEP = 18; // px per frame at the very edge
const DRAG_START_PX = 4;   // movement before a press counts as a drag

function getScrollParent(el) {
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement || document.documentElement;
}

export function enableDragReorder({ container, rowSelector, handleSelector, onReorder, layout = 'vertical' }) {
  if (!container) return;

  const isGrid = layout === 'grid';
  let drag = null; // { pointerId, handle, fromIndex, pos, startY, moved, lastX, lastY, raf, scroller }

  const rowsOf = () => Array.from(container.querySelectorAll(rowSelector));

  function clearIndicators() {
    container.querySelectorAll('.drop-before, .drop-after, .is-dragging')
      .forEach(el => el.classList.remove('drop-before', 'drop-after', 'is-dragging'));
  }

  // Insertion slot 0..n for the pointer. Vertical lists: the first row whose
  // midpoint is below the pointer, or n when the pointer is past every row.
  function slotAt(clientX, clientY, rects) {
    if (!isGrid) {
      for (let i = 0; i < rects.length; i++) {
        if (clientY < rects[i].top + rects[i].height / 2) return i;
      }
      return rects.length;
    }
    // Grid: find the line of cards the pointer is on, then the first card in
    // that line whose centre is right of the pointer.
    const lines = [];                       // [{ start, end }] indexes, end exclusive
    rects.forEach((r, i) => {
      const line = lines[lines.length - 1];
      if (line && r.top < rects[line.start].top + rects[line.start].height * 0.5) line.end = i + 1;
      else lines.push({ start: i, end: i + 1 });
    });
    let line = lines[lines.length - 1];
    for (const l of lines) {
      if (clientY < rects[l.start].bottom + 8) { line = l; break; }   // 8 = half the gap between lines
    }
    for (let i = line.start; i < line.end; i++) {
      if (clientX < rects[i].left + rects[i].width / 2) return i;
    }
    return line.end;
  }

  // True when card i starts a new line of the grid (so a drop "before" it is
  // better drawn as "after" the card ending the line above).
  function startsNewLine(i, rects) {
    return i > 0 && rects[i].top > rects[i - 1].top + rects[i - 1].height * 0.5;
  }

  function paint() {
    const rows = rowsOf();
    clearIndicators();
    if (!rows.length) return;
    rows[drag.fromIndex]?.classList.add('is-dragging');
    const rects = rows.map(r => r.getBoundingClientRect());
    drag.pos = slotAt(drag.lastX, drag.lastY, rects);
    // Dropping in the slot just before or after itself changes nothing, so show no line.
    if (drag.pos === drag.fromIndex || drag.pos === drag.fromIndex + 1) return;
    if (drag.pos >= rows.length) rows[rows.length - 1].classList.add('drop-after');
    else if (isGrid && startsNewLine(drag.pos, rects)) rows[drag.pos - 1].classList.add('drop-after');
    else rows[drag.pos].classList.add('drop-before');
  }

  // Keep scrolling while the pointer rests near the top or bottom edge of the
  // scrolling area (the modal body, or the page), so long lists are reachable.
  function autoScroll() {
    if (!drag) return;
    const s = drag.scroller;
    const isPage = s === document.scrollingElement || s === document.documentElement;
    const top = isPage ? 0 : s.getBoundingClientRect().top;
    const bottom = isPage ? window.innerHeight : s.getBoundingClientRect().bottom;
    let step = 0;
    if (drag.lastY < top + EDGE_PX) step = -MAX_SCROLL_STEP * Math.min(1, (top + EDGE_PX - drag.lastY) / EDGE_PX);
    else if (drag.lastY > bottom - EDGE_PX) step = MAX_SCROLL_STEP * Math.min(1, (drag.lastY - (bottom - EDGE_PX)) / EDGE_PX);
    if (step) {
      if (isPage) window.scrollBy(0, step); else s.scrollTop += step;
      paint();
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function finish(commit) {
    if (!drag) return;
    const d = drag;
    drag = null;
    cancelAnimationFrame(d.raf);
    document.body.classList.remove('is-drag-reordering');
    clearIndicators();
    try { d.handle.releasePointerCapture(d.pointerId); } catch (_) { /* already released */ }
    if (!commit || !d.moved) return;
    const toIndex = d.pos > d.fromIndex ? d.pos - 1 : d.pos;
    if (toIndex !== d.fromIndex) onReorder(d.fromIndex, toIndex);
  }

  container.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest(handleSelector);
    if (!handle || !container.contains(handle)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const row = handle.closest(rowSelector);
    const fromIndex = rowsOf().indexOf(row);
    if (fromIndex < 0) return;
    e.preventDefault(); // no text selection / native drag ghost
    handle.setPointerCapture(e.pointerId);
    drag = {
      pointerId: e.pointerId, handle, fromIndex, pos: fromIndex,
      startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false, raf: 0,
      scroller: getScrollParent(container),
    };
  });

  container.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_START_PX) return;
      drag.moved = true;
      document.body.classList.add('is-drag-reordering');
      drag.raf = requestAnimationFrame(autoScroll);
    }
    paint();
  });

  container.addEventListener('pointerup', (e) => {
    if (drag && e.pointerId === drag.pointerId) finish(true);
  });
  container.addEventListener('pointercancel', (e) => {
    if (drag && e.pointerId === drag.pointerId) finish(false);
  });
  // Escape cancels a drag in progress.
  document.addEventListener('keydown', (e) => {
    if (drag && e.key === 'Escape') finish(false);
  });

  // Keyboard: ArrowUp / ArrowDown (and Left / Right in a grid) on a focused handle.
  const BACK_KEYS = isGrid ? ['ArrowUp', 'ArrowLeft'] : ['ArrowUp'];
  const FORWARD_KEYS = isGrid ? ['ArrowDown', 'ArrowRight'] : ['ArrowDown'];
  container.addEventListener('keydown', (e) => {
    if (!BACK_KEYS.includes(e.key) && !FORWARD_KEYS.includes(e.key)) return;
    const handle = e.target.closest(handleSelector);
    if (!handle || !container.contains(handle)) return;
    const rows = rowsOf();
    const fromIndex = rows.indexOf(handle.closest(rowSelector));
    const toIndex = fromIndex + (BACK_KEYS.includes(e.key) ? -1 : 1);
    if (fromIndex < 0 || toIndex < 0 || toIndex >= rows.length) return;
    e.preventDefault();
    onReorder(fromIndex, toIndex);
    // The caller re-rendered; put focus back on the moved row's handle.
    rowsOf()[toIndex]?.querySelector(handleSelector)?.focus();
  });
}
