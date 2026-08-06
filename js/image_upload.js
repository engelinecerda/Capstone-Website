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

// Caps the long edge at maxEdge before upload — unresized phone photos make
// image-heavy customer pages unusable on mobile data.
export function resizeImageFile(file, maxEdge = MAX_PHOTO_EDGE) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width <= maxEdge && height <= maxEdge) { resolve(file); return; }
        const scale = maxEdge / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          resolve(blob ? new File([blob], file.name, { type: file.type }) : file);
        }, file.type, 0.9);
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
