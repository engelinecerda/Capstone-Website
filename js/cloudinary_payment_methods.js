// js/cloudinary_payment_methods.js
export const CLOUDINARY_CLOUD_NAME    = 'dgneg418t';
export const CLOUDINARY_UPLOAD_PRESET = 'payment_methods';

// Default folder inside Cloudinary where QR images are stored.
export const CLOUDINARY_PM_FOLDER = 'payment_method';

// QR codes are images, so resource type is 'image' (not 'raw' like PDFs).
const RESOURCE_TYPE = 'image';

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
        'Open js/cloudinary_payment_methods.js and set CLOUDINARY_CLOUD_NAME and CLOUDINARY_UPLOAD_PRESET.'
      )
    );
  }

  const folder   = options.folder   ?? CLOUDINARY_PM_FOLDER;
  const publicId = options.publicId ?? null;

  const endpoint =
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${RESOURCE_TYPE}/upload`;

  const formData = new FormData();
  formData.append('file',          file);
  formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);

  if (publicId) {
    formData.append('public_id', publicId);
  } else {
    formData.append('folder', folder);
  }

  // Store the original filename as a context tag for identification
  const baseName = file.name
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  formData.append('context', `original_filename=${baseName}`);

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