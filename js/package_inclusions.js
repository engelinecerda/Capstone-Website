// package_inclusions.js — the one place that knows the shape of a package's
// customizable inclusions, shared by the admin Inventory page and the
// customer reservation form so they can never disagree.
//
// package.inclusion_options (jsonb) is an array of
//   { id, name, required, credit, catalog_id }
//   id          stable text id, unique within the package (a booking records
//               the ids of the inclusions the customer removed)
//   required    true  = always part of the package, the customer can't remove it
//               false = optional: the customer can uncheck it
//   credit      pesos taken off the package price when an OPTIONAL inclusion is
//               removed (0 for required ones)
//   catalog_id  inclusion_catalog row it was picked from, or null for free text
//
// The server (supabase/migrations/20261123_customizable_inclusions.sql)
// validates this shape and recomputes every credit itself; this file is only
// for building the forms and the live price preview.

export function newInclusionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'inc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

const toCredit = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
};

// Sums are rounded to whole centavos so floating-point noise (0.1 + 0.2) can
// never leave a total a hair below the server's exact price floor.
const roundPeso = (n) => Math.round(n * 100) / 100;

// Raw column value -> clean array. Anything malformed is dropped rather than
// thrown on, so a bad row can never break a page that only wants to read.
export function normalizeInclusionOptions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(o => o && typeof o === 'object' && String(o.name || '').trim() && String(o.id || '').trim())
    .map(o => {
      const required = o.required !== false;
      return {
        id: String(o.id),
        name: String(o.name).trim(),
        required,
        credit: required ? 0 : toCredit(o.credit),
        catalogId: o.catalog_id || o.catalogId || null
      };
    });
}

// The shape written back to package.inclusion_options.
export function serializeInclusionOptions(options) {
  return options.map(o => ({
    id: o.id,
    name: String(o.name).trim(),
    required: !!o.required,
    credit: o.required ? 0 : toCredit(o.credit),
    catalog_id: o.catalogId || null
  }));
}

export function optionalCreditTotal(options) {
  return roundPeso(options.filter(o => !o.required).reduce((sum, o) => sum + o.credit, 0));
}

export function hasRemovableInclusions(options) {
  return options.some(o => !o.required);
}

// Credits of the inclusions the customer removed. Ids that are not an
// optional inclusion of this package are ignored (never counted).
export function removedCredit(options, removedIds) {
  const removed = new Set(removedIds || []);
  return roundPeso(options
    .filter(o => !o.required && removed.has(o.id))
    .reduce((sum, o) => sum + o.credit, 0));
}

export function removedOptions(options, removedIds) {
  const removed = new Set(removedIds || []);
  return options.filter(o => !o.required && removed.has(o.id));
}
