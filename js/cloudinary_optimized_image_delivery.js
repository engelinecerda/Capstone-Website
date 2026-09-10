// cloudinary_optimized_image_delivery.js — delivery-time image optimization
// Rather than re-compressing files on upload, this inserts Cloudinary's own
// automatic quality/format/dimension transformation into the URL used to
// *display* an already-uploaded image:
//   - q_auto picks the lowest quality that's perceptually indistinguishable
//     from the original (not a blind "shrink to X%"), typically cutting
//     30-70% of the bytes with no visible loss.
//   - f_auto serves WebP/AVIF to browsers that support it, falling back
//     to the original format otherwise.
//   - w_<targetWidth>,c_limit (only when a caller passes targetWidth) caps
//     the delivered image at that width, downscaling server-side instead of
//     shipping the full uploaded resolution for a small on-page slot. c_limit
//     (not c_fill/c_crop) only ever shrinks, never upscales or crops — the
//     browser's own object-fit still governs cropping/fit within that
//     smaller image, so this can't fight a caller's existing CSS. PageSpeed
//     Insights' "Efficiently encode images" / "Properly size images" audits
//     were flagging exactly this: q_auto,f_auto alone still ships an image
//     at its full upload resolution (e.g. a 1361x960 upload delivered as-is
//     into a 420x280 card) — this is the fix for that specific gap.
// This is retroactive — every image already sitting in Cloudinary benefits
// immediately, not just new uploads — and the stored master is untouched,
// so nothing here can compound across repeated views/edits.
//
// Deliberately NOT applied to every Cloudinary URL in the app:
//   - Payment proof "View Proof" links (admin_record_payment.js, payment.js)
//     — opened for financial verification, and may be a raw PDF resource
//     rather than an image; leave those exactly as uploaded.
//   - Payment method QR codes (admin_payment_options.js) — a failed scan
//     blocks a customer's payment, so this one asset is left untouched
//     rather than accept any perceptual trade-off, however small.
// Only import/call this where a stored image URL is being rendered as a
// photo/logo/banner for a person to look at.

const CLOUDINARY_HOST = 'res.cloudinary.com';
const UPLOAD_SEGMENT = '/image/upload/';

// targetWidth is the caller's own best estimate of the largest CSS pixel
// width this image is ever displayed at on the page (a grid tile, a card
// thumbnail, a full-bleed hero) — pass the display width, not a "safe
// guess"; c_limit only downscales, so passing too small a number is the
// only way this can visibly soften an image. Omit it (or pass 0/undefined)
// for contexts where the true display size can't be known ahead of time
// (e.g. a lightbox that also reuses the same URL for a near-fullscreen
// view) — those still get the q_auto,f_auto quality/format win alone.
export function optimizedImageUrl(url, targetWidth) {
  if (!url || typeof url !== 'string') return url;
  if (!url.includes(CLOUDINARY_HOST) || !url.includes(UPLOAD_SEGMENT)) return url;

  const width = Number(targetWidth);
  const transform = (Number.isFinite(width) && width > 0)
    ? `w_${Math.round(width)},c_limit,q_auto,f_auto`
    : 'q_auto,f_auto';

  // Already has SOME transformation applied (e.g. this function ran once
  // already on a value that got re-passed through it) — replace that
  // segment rather than stacking a second transformation in front of it.
  const uploadIdx = url.indexOf(UPLOAD_SEGMENT);
  const afterUpload = url.slice(uploadIdx + UPLOAD_SEGMENT.length);
  const alreadyTransformed = /^[a-z]_[^/]+\//.test(afterUpload);
  if (alreadyTransformed) {
    const nextSlash = afterUpload.indexOf('/');
    const rest = afterUpload.slice(nextSlash + 1);
    return url.slice(0, uploadIdx + UPLOAD_SEGMENT.length) + transform + '/' + rest;
  }

  return url.replace(UPLOAD_SEGMENT, `${UPLOAD_SEGMENT}${transform}/`);
}