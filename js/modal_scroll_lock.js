// Shared by every modal/drawer/lightbox on the site. A ref count (not a
// boolean) is required because a page can have more than one of these
// capable of being open at once — e.g. a confirmation dialog opened from
// within another modal — so the count only reaches zero once every one of
// them has closed; an inner one closing can never prematurely unlock
// scroll while an outer one is still open. Without this, a modal's own
// scrollable body and the page behind it both accept wheel/touch input at
// once ("double scroll").
//
// Both <html> and <body> are locked. styles.css gives <html> its own
// overflow (overflow-y: scroll; overflow-x: hidden), and when <html> has a
// non-visible overflow the browser stops passing <body>'s overflow up to the
// viewport — so overflow:hidden on <body> alone does NOT stop the page
// scrolling behind a modal. scrollbar-gutter:stable keeps the scrollbar's
// space reserved while locked, so the page doesn't jump sideways when the
// scrollbar would otherwise disappear (same trick as html.sn-lock in
// system_notice.js).
let lockCount = 0;

export function lockBodyScroll() {
  lockCount += 1;
  const root = document.documentElement;
  root.style.overflow = 'hidden';
  root.style.scrollbarGutter = 'stable';
  document.body.style.overflow = 'hidden';
}

export function unlockBodyScroll() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) {
    const root = document.documentElement;
    root.style.overflow = '';
    root.style.scrollbarGutter = '';
    document.body.style.overflow = '';
  }
}
