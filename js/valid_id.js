// The customer's saved valid ID (managed on My Profile).
//
// One ID photo per customer lives in a PRIVATE Supabase Storage bucket at
//   customer-ids/<user_id>/valid-id.jpg
// and profiles.valid_id_uploaded_at says whether one is on file
// (supabase/migrations/20261128_profile_valid_id.sql). The photo is used to
// validate the signature on the customer's contracts; the customer can replace
// or remove it at any time from My Profile.
//
// Used by js/account.js (manage), js/reservations.js (first upload / "use the
// saved one") and js/id_signature_retry.js (replace while fixing a pending
// contract). The Edge Functions read the same object with the service role,
// building the path from the verified caller id.

export const VALID_ID_BUCKET = 'customer-ids';
export const ID_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;   // raw file the customer picks
export const ID_UPLOAD_MAX_EDGE_PX = 1600;             // resized before it is stored / sent
export const ID_UPLOAD_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Fixed path: one ID per customer, and "replace" simply overwrites it.
export function validIdPath(userId) {
    return `${userId}/valid-id.jpg`;
}

export function getIdFileError(file) {
    if (!ID_UPLOAD_ALLOWED_TYPES.includes(file.type)) return 'Please upload your ID as a JPG, PNG or WEBP photo.';
    if (!file.size) return 'That file is empty. Please choose another photo.';
    if (file.size > ID_UPLOAD_MAX_BYTES) return 'That photo is too large. Please upload one under 10 MB.';
    return null;
}

// Phone photos are several MB; neither the comparison nor storage needs that.
// Scales the long edge down to ID_UPLOAD_MAX_EDGE_PX and re-encodes as JPEG
// (which also gives PNG/WEBP a predictable type for storage and the Edge
// Functions).
export function resizeIdImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            const scale = Math.min(1, ID_UPLOAD_MAX_EDGE_PX / Math.max(img.naturalWidth, img.naturalHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable image')); };
        img.src = url;
    });
}

function dataUrlToBlob(dataUrl) {
    const [header, base64] = String(dataUrl).split(',');
    const mime = /data:([^;]+)/.exec(header || '')?.[1] || 'image/jpeg';
    const binary = atob(base64 || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
}

function isMissingColumnError(error) {
    const text = `${error?.message || ''} ${error?.details || ''}`.toLowerCase();
    return error?.code === '42703' || error?.code === 'PGRST204' || text.includes('valid_id_uploaded_at');
}

// { hasId, uploadedAt, unavailable }. `unavailable` = the migration isn't
// applied yet (column missing), so callers fall back to "no ID on file".
export async function fetchValidIdStatus(supabase, userId) {
    const { data, error } = await supabase
        .from('profiles')
        .select('valid_id_uploaded_at')
        .eq('user_id', userId)
        .maybeSingle();

    if (error) {
        if (isMissingColumnError(error)) return { hasId: false, uploadedAt: null, unavailable: true };
        throw error;
    }
    const uploadedAt = data?.valid_id_uploaded_at || null;
    return { hasId: !!uploadedAt, uploadedAt, unavailable: false };
}

// True when the stored photo really exists (the profile flag could be stale if
// the file was ever removed by hand).
export async function validIdFileExists(supabase, userId) {
    const { data, error } = await supabase.storage
        .from(VALID_ID_BUCKET)
        .list(userId, { limit: 5, search: 'valid-id.jpg' });
    if (error) throw error;
    return (data || []).some((item) => item.name === 'valid-id.jpg');
}

// Short-lived link for showing the saved ID back to its owner. The bucket is
// private, so there is no permanent URL.
export async function getValidIdPreviewUrl(supabase, userId, ttlSeconds = 300) {
    const { data, error } = await supabase.storage
        .from(VALID_ID_BUCKET)
        .createSignedUrl(validIdPath(userId), ttlSeconds);
    if (error) throw error;
    return data?.signedUrl || null;
}

// Saves (or replaces) the customer's ID. `dataUrl` is the resized JPEG from
// resizeIdImage(). Returns the new uploaded-at timestamp.
export async function saveValidId(supabase, userId, dataUrl) {
    const { error: uploadError } = await supabase.storage
        .from(VALID_ID_BUCKET)
        .upload(validIdPath(userId), dataUrlToBlob(dataUrl), {
            contentType: 'image/jpeg',
            upsert: true,
            cacheControl: '0'
        });
    if (uploadError) throw uploadError;

    const uploadedAt = new Date().toISOString();
    const { error: profileError } = await supabase
        .from('profiles')
        .update({ valid_id_uploaded_at: uploadedAt })
        .eq('user_id', userId);
    if (profileError) throw profileError;
    return uploadedAt;
}

// Deletes the stored photo and clears the flag.
export async function removeValidId(supabase, userId) {
    const { error: removeError } = await supabase.storage
        .from(VALID_ID_BUCKET)
        .remove([validIdPath(userId)]);
    if (removeError) throw removeError;

    const { error: profileError } = await supabase
        .from('profiles')
        .update({ valid_id_uploaded_at: null })
        .eq('user_id', userId);
    if (profileError) throw profileError;
}
