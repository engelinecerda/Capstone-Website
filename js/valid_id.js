// The customer's saved valid ID (managed on My Profile).
//
// One ID photo per customer lives in a PRIVATE Supabase Storage bucket at
//   customer-ids/<user_id>/valid-id.jpg        (front)
//   customer-ids/<user_id>/valid-id-back.jpg   (back)
// and profiles.valid_id_uploaded_at / valid_id_back_uploaded_at say which are on file
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

// Two photos per customer: the FRONT (the original object, so IDs saved before
// the back existed stay valid) and the BACK. "Replace" simply overwrites.
export const ID_SIDES = ['front', 'back'];
export const ID_SIDE_LABELS = { front: 'Front of ID', back: 'Back of ID' };

export function validIdPath(userId, side = 'front') {
    return side === 'back' ? `${userId}/valid-id-back.jpg` : `${userId}/valid-id.jpg`;
}

const SIDE_COLUMN = { front: 'valid_id_uploaded_at', back: 'valid_id_back_uploaded_at' };

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
    return error?.code === '42703' || error?.code === 'PGRST204' || text.includes('valid_id_uploaded_at') || text.includes('valid_id_back_uploaded_at');
}

// { hasFront, hasBack, hasId, uploadedAt, backUploadedAt, unavailable }.
// `hasId` means the ID is COMPLETE (front and back). `unavailable` = the first
// migration isn't applied (no columns at all), so callers fall back to "no ID".
// If only the back column is missing (second migration not applied yet) the
// back can't be tracked, so a front photo alone counts as complete rather than
// asking customers for something that cannot be saved.
async function fetchPhotoFlags(supabase, userId) {
    const { data, error } = await supabase
        .from('profiles')
        .select('valid_id_uploaded_at, valid_id_back_uploaded_at')
        .eq('user_id', userId)
        .maybeSingle();

    if (error) {
        if (!isMissingColumnError(error)) throw error;
        const legacy = await supabase
            .from('profiles')
            .select('valid_id_uploaded_at')
            .eq('user_id', userId)
            .maybeSingle();
        if (legacy.error) {
            if (isMissingColumnError(legacy.error)) {
                return { hasFront: false, hasBack: false, hasId: false, uploadedAt: null, backUploadedAt: null, unavailable: true, backUnavailable: false };
            }
            throw legacy.error;
        }
        const uploadedAt = legacy.data?.valid_id_uploaded_at || null;
        return { hasFront: !!uploadedAt, hasBack: false, hasId: !!uploadedAt, uploadedAt, backUploadedAt: null, unavailable: false, backUnavailable: true };
    }
    const uploadedAt = data?.valid_id_uploaded_at || null;
    const backUploadedAt = data?.valid_id_back_uploaded_at || null;
    return {
        hasFront: !!uploadedAt,
        hasBack: !!backUploadedAt,
        hasId: !!uploadedAt && !!backUploadedAt,
        uploadedAt,
        backUploadedAt,
        unavailable: false,
        backUnavailable: false
    };
}

// What the upload-time check and the manager decided about the ID
// (valid_id_review, readable by its owner). status: unchecked | clear | flagged |
// approved | rejected. null when the table isn't there yet or nothing is saved.
async function fetchReviewStatus(supabase, userId) {
    const { data, error } = await supabase
        .from('valid_id_review')
        .select('status, review_note')
        .eq('user_id', userId)
        .maybeSingle();
    if (error) return { reviewStatus: null, reviewNote: null };
    return { reviewStatus: data?.status || null, reviewNote: data?.review_note || null };
}

// Photo flags plus the review state. A REJECTED ID is no longer "on file": the
// customer has to upload new photos, so `hasId` is false until they do.
export async function fetchValidIdStatus(supabase, userId) {
    const photos = await fetchPhotoFlags(supabase, userId);
    const review = photos.hasFront || photos.hasBack ? await fetchReviewStatus(supabase, userId) : { reviewStatus: null, reviewNote: null };
    const rejected = review.reviewStatus === 'rejected';
    return { ...photos, ...review, rejected, hasId: photos.hasId && !rejected };
}

// Right after saving photos: asks the server to look for a signature on the
// saved ID. Best effort and never throws, since a failure here must not block
// the customer. Returns { status, check, flagged, needsBetterPhoto, message }.
export async function checkSavedIdSignature(supabase) {
    try {
        const { data, error } = await supabase.functions.invoke('check-valid-id', { body: {} });
        if (error || !data?.success) return { status: 'unchecked', check: 'error', flagged: false, needsBetterPhoto: false, message: '' };
        const check = data.check;
        return {
            status: data.status,
            check,
            flagged: check === 'no_signature',
            needsBetterPhoto: check === 'unclear' || check === 'not_an_id',
            message: ID_CHECK_MESSAGES[check] || ''
        };
    } catch {
        return { status: 'unchecked', check: 'error', flagged: false, needsBetterPhoto: false, message: '' };
    }
}

// What to tell the customer about each result of the upload-time check.
export const ID_CHECK_MESSAGES = {
    no_signature: 'We couldn\u2019t find a signature on your ID. That\u2019s okay: our team will review it before it\u2019s used.',
    unclear: 'Your ID photos look too blurry, dark or cropped for us to read. Please upload clearer photos of the front and back.',
    not_an_id: 'The front photo doesn\u2019t look like an ID. Please upload a clear photo of the front of your valid ID.'
};

// Which stored photos really exist (a profile flag could be stale if a file
// was ever removed by hand). { front, back }.
export async function validIdFilesExist(supabase, userId) {
    const { data, error } = await supabase.storage
        .from(VALID_ID_BUCKET)
        .list(userId, { limit: 10 });
    if (error) throw error;
    const names = new Set((data || []).map((item) => item.name));
    return { front: names.has('valid-id.jpg'), back: names.has('valid-id-back.jpg') };
}

// Kept for older callers: does the FRONT exist.
export async function validIdFileExists(supabase, userId) {
    return (await validIdFilesExist(supabase, userId)).front;
}

// Short-lived link for showing a saved ID photo back to its owner. The bucket
// is private, so there is no permanent URL.
export async function getValidIdPreviewUrl(supabase, userId, side = 'front', ttlSeconds = 300) {
    const { data, error } = await supabase.storage
        .from(VALID_ID_BUCKET)
        .createSignedUrl(validIdPath(userId, side), ttlSeconds);
    if (error) throw error;
    return data?.signedUrl || null;
}

// Saves (or replaces) one side of the customer's ID. `dataUrl` is the resized
// JPEG from resizeIdImage(). Returns the new uploaded-at timestamp.
export async function saveValidId(supabase, userId, dataUrl, side = 'front') {
    const { error: uploadError } = await supabase.storage
        .from(VALID_ID_BUCKET)
        .upload(validIdPath(userId, side), dataUrlToBlob(dataUrl), {
            contentType: 'image/jpeg',
            upsert: true,
            cacheControl: '0'
        });
    if (uploadError) throw uploadError;

    const uploadedAt = new Date().toISOString();
    const { error: profileError } = await supabase
        .from('profiles')
        .update({ [SIDE_COLUMN[side] || SIDE_COLUMN.front]: uploadedAt })
        .eq('user_id', userId);
    if (profileError) throw profileError;
    return uploadedAt;
}

// Deletes both stored photos and clears both flags.
export async function removeValidId(supabase, userId) {
    const { error: removeError } = await supabase.storage
        .from(VALID_ID_BUCKET)
        .remove([validIdPath(userId, 'front'), validIdPath(userId, 'back')]);
    if (removeError) throw removeError;

    const { error: profileError } = await supabase
        .from('profiles')
        .update({ valid_id_uploaded_at: null, valid_id_back_uploaded_at: null })
        .eq('user_id', userId);
    if (profileError) {
        // Back column not there yet (migration pending): clear the front only.
        if (!isMissingColumnError(profileError)) throw profileError;
        const legacy = await supabase.from('profiles').update({ valid_id_uploaded_at: null }).eq('user_id', userId);
        if (legacy.error) throw legacy.error;
    }
}
