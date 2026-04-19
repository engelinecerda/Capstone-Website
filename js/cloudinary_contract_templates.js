// js/cloudinary.js
// ─────────────────────────────────────────────────────────────────────────────
// Cloudinary configuration and reusable upload helper for ELI Coffee Events.
//
// ONE-TIME SETUP
// ──────────────
// 1. Log in to https://cloudinary.com and open your Dashboard.
// 2. Copy your "Cloud name" → replace CLOUDINARY_CLOUD_NAME below.
// 3. Create an **unsigned** upload preset:
//      Settings → Upload → Upload Presets → Add upload preset
//      • Signing Mode: Unsigned
//      • (Optional) set a default folder, e.g. "eli-coffee"
//      Save, then copy the preset name → replace CLOUDINARY_UPLOAD_PRESET below.
//
// SECURITY NOTE
// ─────────────
// Cloud name and upload preset are intentionally public — unsigned presets are
// designed for client-side use. Never paste your API secret or API key here.
// ─────────────────────────────────────────────────────────────────────────────

export const CLOUDINARY_CLOUD_NAME    = 'dgneg418t';     // e.g. 'elicoffee'
export const CLOUDINARY_UPLOAD_PRESET = 'eli_coffee_contract_templates';  // e.g. 'eli_unsigned'

// Default folder inside Cloudinary where contract templates are stored.
export const CLOUDINARY_TEMPLATES_FOLDER = 'eli-coffee/contract-templates';

// Cloudinary treats PDFs and Office documents as "raw" resources.
const RESOURCE_TYPE = 'raw';

/**
 * Upload a File to Cloudinary via the unsigned upload API.
 *
 * @param {File}     file              - File object from <input type="file"> or drag-drop.
 * @param {object}   [options]
 * @param {string}   [options.folder]      - Override the default upload folder.
 * @param {string}   [options.publicId]    - Custom public_id (auto-generated if omitted).
 * @param {Function} [options.onProgress]  - Called with (percent: number, loaded, total).
 *
 * @returns {Promise<{
 *   secureUrl: string,
 *   publicId:  string,
 *   format:    string,
 *   bytes:     number
 * }>}
 */
export function uploadToCloudinary(file, options = {}) {
  if (
    !CLOUDINARY_CLOUD_NAME ||
    CLOUDINARY_CLOUD_NAME === 'YOUR_CLOUD_NAME'
  ) {
    return Promise.reject(
      new Error(
        'Cloudinary is not configured. ' +
        'Open js/cloudinary.js and set CLOUDINARY_CLOUD_NAME and CLOUDINARY_UPLOAD_PRESET.'
      )
    );
  }

  const folder   = options.folder   ?? CLOUDINARY_TEMPLATES_FOLDER;
  const publicId = options.publicId ?? null;

  const endpoint =
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${RESOURCE_TYPE}/upload`;

  const formData = new FormData();
  formData.append('file',           file);
  formData.append('upload_preset',  CLOUDINARY_UPLOAD_PRESET);
  formData.append('folder',         folder);

  // Store the original filename as a context tag for easy identification in the
  // Cloudinary Media Library.
  const baseName = file.name
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  formData.append('context', `original_filename=${baseName}`);

  if (publicId) {
    formData.append('public_id', publicId);
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint);

    // Progress reporting
    if (typeof options.onProgress === 'function') {
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) {
          const pct = Math.round((event.loaded / event.total) * 100);
          options.onProgress(pct, event.loaded, event.total);
        }
      });
    }

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const result = JSON.parse(xhr.responseText);
          resolve({
            secureUrl: result.secure_url,
            publicId:  result.public_id,
            format:    result.format,
            bytes:     result.bytes,
          });
        } catch {
          reject(new Error('Cloudinary returned an unreadable response.'));
        }
      } else {
        let message = `Cloudinary upload failed (HTTP ${xhr.status}).`;
        try {
          const err = JSON.parse(xhr.responseText);
          if (err?.error?.message) message = err.error.message;
        } catch { /* ignore */ }
        reject(new Error(message));
      }
    });

    xhr.addEventListener('error', () =>
      reject(new Error('Network error — could not reach Cloudinary.'))
    );
    xhr.addEventListener('abort', () =>
      reject(new Error('Upload cancelled.'))
    );

    xhr.send(formData);
  });
}