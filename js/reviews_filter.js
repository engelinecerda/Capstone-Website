/* -------------------------------------------------------------
Keyboard mash & basic gibberish
------------------------------------------------------------- */
export function isNonsenseReview(comment) {
    if (comment === null || comment === undefined) return false;
    const raw = String(comment).trim();
    if (raw.length === 0) return false;
    if (raw.length < 4) return true;

    const lower = raw.toLowerCase();

    const keyboardMashPatterns = [
        /asdf+/i, /qwer+/i, /zxcv+/i, /hjkl+/i, /jkl+/i,
        /^[asdfghjkl]{4,}$/i,
        /^[qwertyuiop]{4,}$/i,
        /^[zxcvbnm]{4,}$/i,
    ];
    if (keyboardMashPatterns.some(rx => rx.test(lower.replace(/\s+/g, '')))) return true;
    if (/(.)\1{5,}/.test(raw)) return true;

    const lettersOnly = lower.replace(/[^a-z]/g, '');
    if (lettersOnly.length >= 6 && !/[aeiou]/.test(lettersOnly)) return true;

    const letterCount = (raw.match(/[a-zA-Z\u00C0-\u024F]/g) || []).length;
    const nonSpaceLength = raw.replace(/\s/g, '').length;
    if (nonSpaceLength >= 6 && letterCount / nonSpaceLength < 0.4) return true;

    const words = lower.split(/\s+/).filter(Boolean);
    if (words.length >= 4 && new Set(words).size === 1) return true;

    if (raw.length >= 10) {
        const uniqueChars = new Set(lower.replace(/\s/g, '')).size;
        if (uniqueChars <= 3) return true;
    }

    const spamWords = ['asdf', 'qwerty', 'test123', 'lorem ipsum', 'sample text', 'placeholder', 'dummy text'];
    if (spamWords.some(w => lower === w || lower.startsWith(w + ' '))) return true;

    const blockedExact = ['fuck', 'shit', 'asshole'];
    if (blockedExact.includes(lower)) return true;

    if (/(https?:\/\/|www\.)\S+/i.test(raw)) return true;

    return false;
}

/* -------------------------------------------------------------
   LAYER 1: Topic Relevance 
------------------------------------------------------------- */
export function isOffTopic(comment) {
    if (!comment) return false;
    const lower = comment.toLowerCase();

    // Short reviews get a pass — "Great!" is valid
    if (lower.length < 25) return false;

    const relevantKeywords = [
        // Food & drink
        'coffee', 'cafe', 'café', 'drink', 'food', 'menu', 'meal', 'snack',
        'dessert', 'cake', 'pastry', 'tea', 'latte', 'espresso', 'cappuccino',
        'mocha', 'frappe', 'milk', 'sugar', 'taste', 'tasty', 'delicious',
        'flavor', 'flavour', 'sweet', 'bitter', 'fresh', 'hot', 'cold', 'iced',

        // Service & staff
        'staff', 'service', 'server', 'waiter', 'waitress', 'crew', 'team',
        'friendly', 'rude', 'helpful', 'accommodating', 'attentive', 'polite',

        // Place & ambiance
        'place', 'spot', 'location', 'shop', 'store', 'venue', 'ambiance',
        'ambience', 'atmosphere', 'vibe', 'cozy', 'aesthetic', 'clean', 'comfortable',
        'quiet', 'noisy', 'wifi', 'seat', 'seating', 'table', 'chair', 'lounge',
        'space', 'interior', 'decor', 'music', 'lighting',

        // Experience
        'visit', 'recommend', 'experience', 'event', 'reservation', 'booking',
        'birthday', 'meeting', 'date', 'gathering', 'celebration', 'party',
        'shower', 'group', 'family', 'friends',

        // Quality words
        'good', 'great', 'amazing', 'awesome', 'wonderful', 'excellent',
        'perfect', 'lovely', 'nice', 'best', 'love', 'liked', 'enjoyed',
        'bad', 'worst', 'terrible', 'disappointing', 'okay', 'average',
        'expensive', 'cheap', 'affordable', 'worth', 'price', 'value', 'sulit',

        // Filipino/Tagalog cafe terms
        'masarap', 'maganda', 'mahal', 'mura', 'ganda', 'sarap',
        'bagay', 'okay', 'ayos', 'bigay', 'serbisyo',

        // ELI-specific
        'eli', 'binangonan', 'antipolo'
    ];

    const matches = relevantKeywords.filter(word => lower.includes(word)).length;
    return matches === 0;
}

/* -------------------------------------------------------------
 Gibberish Words
------------------------------------------------------------- */
export function hasGibberishWords(comment) {
    if (!comment) return false;
    const words = comment.toLowerCase().match(/[a-z]+/g) || [];
    if (words.length < 3) return false;

    let gibberishCount = 0;

    for (const word of words) {
        if (word.length < 4) continue;

        // 5+ consonants in a row
        if (/[bcdfghjklmnpqrstvwxyz]{5,}/.test(word)) {
            gibberishCount++;
            continue;
        }
        // 4+ vowels in a row
        if (/[aeiou]{4,}/.test(word)) {
            gibberishCount++;
            continue;
        }
        // Long word with no vowels
        if (word.length >= 5 && !/[aeiouy]/.test(word)) {
            gibberishCount++;
            continue;
        }
        // Improbable letter pairs
        const badPairs = /(qz|qx|qj|vx|jq|xz|wx|kq|fq|vq|jx|kx|zx|qf|qk|jz|jv)/;
        if (badPairs.test(word)) {
            gibberishCount++;
            continue;
        }
    }

    return (gibberishCount / words.length) > 0.3;
}

/* -------------------------------------------------------------
Filler Text Detector
------------------------------------------------------------- */
export function isFillerText(comment) {
    if (!comment) return false;
    const lower = comment.toLowerCase();

    const fillerPhrases = [
        // Lorem ipsum variants
        'lorem ipsum', 'dolor sit amet', 'consectetur', 'adipiscing elit',
        'sed do eiusmod', 'tempor incididunt', 'ut labore', 'magna aliqua',

        // Common pangrams
        'the quick brown fox', 'jumped over the lazy', 'pack my box',
        'sphinx of black quartz', 'jackdaws love',
        'every good boy', 'how vexingly quick',

        // Common test data
        'john doe', 'jane doe', 'foo bar', 'foobar', 'baz qux',
        'sample text', 'this is a test', 'placeholder text',

        // AI-generated tells
        'as an ai', 'as a language model', 'i cannot provide',
        'i apologize but', "i don't have personal experiences"
    ];

    return fillerPhrases.some(phrase => lower.includes(phrase));
}

/* -------------------------------------------------------------
combines all layers above
------------------------------------------------------------- */
export function shouldHideReview(comment) {
    if (isNonsenseReview(comment)) {
        return { hide: true, reason: 'gibberish' };
    }
    if (isFillerText(comment)) {
        return { hide: true, reason: 'filler' };
    }
    if (hasGibberishWords(comment)) {
        return { hide: true, reason: 'fake-words' };
    }
    if (isOffTopic(comment)) {
        return { hide: true, reason: 'off-topic' };
    }
    return { hide: false, reason: null };
}