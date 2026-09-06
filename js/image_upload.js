// image_upload.js — shared Cloudinary image pipeline.
// Extracted from js/super_admin_packages.js so any admin feature that needs
// to upload/replace/delete an image (package photos, Page Content headers
// and gallery) uses one implementation instead of a second copy.
// Image host: Cloudinary (cloud dgneg418t).

export const CLOUDINARY_UPLOAD_URL = 'https://api.cloudinary.com/v1_1/dgneg418t/image/upload';
export const CLOUDINARY_UPLOAD_PRESET = 'eli_coffee_packages';
export const MAX_PHOTO_EDGE = 1600;

export async function uploadToCloudinary(file, folder = 'eli_coffee_packages', preset = CLOUDINARY_UPLOAD_PRESET) {
  const form = new FormData();
  form.append('file', file);
  form.append('upload_preset', preset);
  form.append('folder', folder);

  const res = await fetch(CLOUDINARY_UPLOAD_URL, { method: 'POST', body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Image upload failed (HTTP ${res.status})`);
  }
  const data = await res.json();
  return data.secure_url;
}

// Best-effort — a failed Cloudinary cleanup should never block a DB delete
// the admin is waiting on (mirrors the payment-methods delete pattern).
export async function destroyCloudinaryImage(supabase, imageUrl) {
  if (!imageUrl) return;
  try {
    await supabase.functions.invoke('delete-cloudinary-image', { body: { image_url: imageUrl } });
  } catch (err) {
    // Non-blocking cleanup of an already-failed/replaced upload — nothing
    // for the user to act on either way.
  }
}

export function validateImageFile(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    return 'Only JPG, PNG, or WEBP images are allowed.';
  }
  if (file.size > 5 * 1024 * 1024) {
    return 'Image must be under 5 MB.';
  }
  return null;
}

// Feature-detected once per page load (cheap: a single toDataURL check) and
// cached — no per-image alpha inspection needed since WebP natively supports
// transparency.
let _webpSupported = null;
function supportsWebP() {
  if (_webpSupported !== null) return _webpSupported;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    _webpSupported = canvas.toDataURL('image/webp').indexOf('data:image/webp') === 0;
  } catch {
    _webpSupported = false;
  }
  return _webpSupported;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

// Caps the long edge at maxEdge (if needed) and converts to WebP before
// upload, with a size-guard: if the encoded result isn't actually smaller
// than the original, the original is uploaded instead — so this can never
// make an upload larger. Falls back to today's resize-only behavior on
// browsers that can't encode WebP.
export function resizeImageFile(file, maxEdge = MAX_PHOTO_EDGE) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = async () => {
        let { width, height } = img;
        const oversized = width > maxEdge || height > maxEdge;
        if (oversized) {
          const scale = maxEdge / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        if (supportsWebP()) {
          const webpBlob = await canvasToBlob(canvas, 'image/webp', 0.85);
          if (webpBlob && webpBlob.size < file.size) {
            const webpName = file.name.replace(/\.[^.]+$/, '') + '.webp';
            resolve(new File([webpBlob], webpName, { type: 'image/webp' }));
            return;
          }
          // WebP didn't win on size — fall through to the resize-only path
          // below (or the original file, if it wasn't oversized either).
        }

        if (!oversized) { resolve(file); return; }
        const blob = await canvasToBlob(canvas, file.type, 0.9);
        resolve(blob ? new File([blob], file.name, { type: file.type }) : file);
      };
      img.onerror = () => resolve(file);
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

export function previewImageFile(file, previewEl, placeholderEl, fileNameEl) {
  fileNameEl.textContent = file.name;
  const reader = new FileReader();
  reader.onload = e => {
    previewEl.src = e.target.result;
    previewEl.classList.remove('hidden');
    placeholderEl.style.display = 'none';
  };
  reader.readAsDataURL(file);
}

export function clearImageUI(previewEl, placeholderEl, fileNameEl, inputEl) {
  previewEl.src = '';
  previewEl.classList.add('hidden');
  placeholderEl.style.display = '';
  fileNameEl.textContent = 'No file chosen';
  if (inputEl) inputEl.value = '';
}