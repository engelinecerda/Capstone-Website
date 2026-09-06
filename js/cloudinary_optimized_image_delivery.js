// cloudinary_optimized_image_delivery.js — delivery-time image optimization 
// Rather than re-compressing files on upload, this inserts Cloudinary's
// own automatic quality/format transformation (q_auto,f_auto) into the
// URL used to *display* an already-uploaded image:
//   - q_auto picks the lowest quality that's perceptually indistinguishable
//     from the original (not a blind "shrink to X%"), typically cutting
//     30-70% of the bytes with no visible loss.
//   - f_auto serves WebP/AVIF to browsers that support it, falling back
//     to the original format otherwise.
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
const TRANSFORM = 'q_auto,f_auto';

export function optimizedImageUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (!url.includes(CLOUDINARY_HOST) || !url.includes(UPLOAD_SEGMENT)) return url;
  if (url.includes(`${UPLOAD_SEGMENT}${TRANSFORM}/`)) return url; // already applied

  return url.replace(UPLOAD_SEGMENT, `${UPLOAD_SEGMENT}${TRANSFORM}/`);
}