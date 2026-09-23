// catering_section_hints.js — the customer-facing hint copy for each
// catering section (Main Dish, Vegetable, Pasta, Dessert, Rice, Drinks…),
// single-sourced so it can only be defined once.
//
// Originally this text was defined only inside reservations.js
// (CATERING_SECTION_META). The Section Restrictions screen in
// super_admin_packages.js now shows a live preview of that same hint next
// to each row (so an admin doesn't have to mentally translate "Min 3,
// Max 3" into "Choose 3 dishes…" themselves, and catches wording mismatches
// before they ship) — that preview imports this module rather than keeping
// its own copy, so the two can never say something different for the same
// rule. Any wording change here changes both places at once.

export const CATERING_SECTION_META = {
    pax:       { label: 'Pax Count', hint: () => 'Choose how many guests this catering order serves \u2014 this sets the default tray size for every dish. You can customize any individual dish\u2019s pax afterward.' },
    main:      { label: 'Main Dish', hint: (required, max) => `Choose ${max} dish${max === 1 ? '' : 'es'} below for your main course \u2014 mix and match dishes until you reach ${max}.` },
    vegetable: { label: 'Vegetable', hint: (required) => required ? 'Choose 1 vegetable dish for your event.' : 'Optional add-on \u2014 include a vegetable dish, or skip it.' },
    pasta:     { label: 'Pasta',     hint: (required) => required ? 'Choose 1 pasta dish for your event.' : 'Optional add-on \u2014 include a pasta dish, or skip it.' },
    dessert:   { label: 'Dessert',   hint: (required) => required ? 'Choose 1 dessert for your event.' : 'Optional add-on \u2014 include a dessert, or skip it.' },
    rice:      { label: 'Rice',      hint: (required) => required ? 'Included with your package \u2014 choose your rice.' : 'Optional add-on \u2014 include steamed rice, or skip it.' },
    drinks:    { label: 'Drink',     hint: (required) => required ? 'Included with your package \u2014 choose your drink.' : 'Optional add-on \u2014 include a drink, or skip it.' }
};

// Fallback for a tag with no entry above (e.g. 'addon') — matches the
// inline fallback reservations.js's getCateringSections() used to apply
// itself before this module existed.
function fallbackMeta(tag) {
    return { label: tag, hint: (required) => required ? 'Required for this package.' : 'Optional add-on.' };
}

// min/max are the *effective* section rule (an explicit catering_section_rule
// row's min_select/max_select, or the caller's own fallback-derived values —
// see getCateringSectionRule() in reservations.js). Mirrors exactly how
// getCateringSections() there calls meta.hint(required, max ?? min).
export function cateringSectionHint(tag, minSelect, maxSelect) {
    const required = (minSelect || 0) > 0;
    const max = maxSelect ?? minSelect ?? 0;
    const meta = CATERING_SECTION_META[tag] || fallbackMeta(tag);
    return meta.hint(required, max);
}