// Shared by every modal/drawer/lightbox on the site. A ref count (not a
// boolean) is required because a page can have more than one of these
// capable of being open at once — e.g. a confirmation dialog opened from
// within another modal — so the count only reaches zero once every one of
// them has closed; an inner one closing can never prematurely unlock
// scroll while an outer one is still open. Without this, a modal's own
// scrollable body and the page behind it both accept wheel/touch input at
// once ("double scroll").
let lockCount = 0;

export function lockBodyScroll() {
  lockCount += 1;
  document.body.style.overflow = 'hidden';
}

export function unlockBodyScroll() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) {
    document.body.style.overflow = '';
  }
}
