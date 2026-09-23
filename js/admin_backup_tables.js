// admin_backup_tables.js
// What Backup & Restore covers, and how it reads and writes it.
// js/super_admin_backup.js owns the UI and Google Drive; everything that
// touches the database lives here so the table list has ONE home.
//
// KEEP THIS IN SYNC WITH THE SCHEMA: when a migration adds a table, add it to
// BACKUP_TABLE_CONFIG below (or to NOT_BACKED_UP with the reason). A table
// missing from both is silently absent from every backup.
//
// Order matters: parents come before the tables that reference them, so a
// restore can insert in this order without tripping foreign keys.
//
// Per-table options:
//   pk       primary key column(s) — also the stable sort used while paging
//   conflict upsert target when it should be a natural key instead of the pk
//            (rows seeded by migrations get fresh uuids in a rebuilt database,
//            so matching on the pk would collide with the unique key)
//   restore  false = saved in the backup, never written back (see `why`)
//   defer    FK columns that are nulled on the first pass and set on a second
//            pass, to break reference cycles (payment <-> reservation_extensions)
//   resync   true = restoring this table can leave a sequence/counter behind
//            its data, so backup_resync_sequences() runs afterwards

export const BACKUP_TABLE_CONFIG = [
  // ── People ────────────────────────────────────────────────────────────────
  { name: 'profiles',                      pk: 'user_id' },
  { name: 'staff_roster',                  pk: 'staff_id', resync: true },

  // ── Packages & catalogue ─────────────────────────────────────────────────
  { name: 'package_category',              pk: 'package_category_id' },
  { name: 'package',                       pk: 'package_id' },
  { name: 'package_tier',                  pk: 'tier_id' },
  { name: 'venue',                         pk: 'venue_id' },
  { name: 'package_venue',                 pk: ['package_id', 'venue_id'] },
  { name: 'package_photo',                 pk: 'photo_id' },
  { name: 'badge',                         pk: 'badge_id',        conflict: 'badge_key' },
  { name: 'package_badge',                 pk: 'package_badge_id' },
  { name: 'package_discount',              pk: 'discount_id' },
  { name: 'catering_dish_category',        pk: 'category_id' },
  { name: 'catering_dish',                 pk: 'dish_id' },

  // ── Contract templates ───────────────────────────────────────────────────
  { name: 'contract_templates',            pk: 'template_id' },
  { name: 'contract_template_clause',      pk: 'clause_id' },
  { name: 'contract_locked_clause',        pk: 'clause_id',       conflict: 'key' },
  { name: 'contract_field',                pk: 'field_id',        conflict: 'token' },

  // ── Configuration & site content ─────────────────────────────────────────
  { name: 'event_types',                   pk: 'id' },
  { name: 'payment_type',                  pk: 'id',              conflict: 'code' },
  { name: 'payment_method',                pk: 'payment_method_id' },
  { name: 'system_settings',               pk: 'system_settings_id', conflict: 'setting_key' },
  { name: 'operating_hours',               pk: 'weekday' },
  { name: 'scheduling_settings',           pk: 'id' },
  { name: 'scope_capacity',                pk: 'scope' },
  { name: 'venue_capacity',                pk: 'venue_id' },
  { name: 'calendar_blackouts',            pk: 'blackout_id' },
  { name: 'notification_trigger',          pk: 'code' },
  { name: 'notification_template',         pk: 'trigger_code' },
  { name: 'page_header',                   pk: 'id',              conflict: 'page_key' },
  { name: 'gallery_image',                 pk: 'id' },
  { name: 'about_section',                 pk: 'section_key' },
  { name: 'about_value',                   pk: 'id' },
  { name: 'faq',                           pk: 'id' },
  { name: 'business_location',             pk: 'id' },
  { name: 'business_contact',              pk: 'id' },
  { name: 'landing_service',               pk: 'id' },
  { name: 'menu_section',                  pk: 'id' },
  { name: 'menu_banner',                   pk: 'id' },
  { name: 'announcement',                  pk: 'id' },
  { name: 'maintenance_mode',              pk: 'id', restore: false,
    why: 'live on/off switch for the customer site — restoring an old snapshot could flip it mid-restore' },

  // ── Reservations & money ─────────────────────────────────────────────────
  { name: 'reservations',                  pk: 'reservation_id', resync: true },
  { name: 'reservation_contracts',         pk: 'reservation_contract_id' },
  { name: 'contract_signatures',           pk: 'signature_id' },
  { name: 'reservation_staff_assignments', pk: 'assignment_id', resync: true },
  { name: 'reservation_status',            pk: 'status_id' },
  { name: 'reschedule_requests',           pk: 'reschedule_request_id' },
  { name: 'payment',                       pk: 'payment_id',
    defer: ['extension_id', 'reversal_of_payment_id'] },
  { name: 'reservation_extensions',        pk: 'extension_id' },
  { name: 'receipts',                      pk: 'receipt_id' },
  { name: 'reservation_cancellations',     pk: 'cancellation_id' },
  { name: 'reviews',                       pk: 'review_id' },
  { name: 'reservation_forecast',          pk: 'forecast_id' },

  // ── Logs (kept in the backup for the record, never written back) ─────────
  { name: 'audit_log',                     pk: 'audit_id', restore: false,
    why: 'the audit trail is append-only — restoring must not rewrite it' },
  { name: 'notifications',                 pk: 'id', restore: false,
    why: 'inserting rows re-triggers email dispatch to customers' },
  { name: 'reminder_sent',                 pk: 'id', restore: false,
    why: 'written only by the reminder job; admins have read-only access' },
];

// Tables that exist in the schema but are deliberately NOT backed up.
export const NOT_BACKED_UP = {
  login_failure_tracking:      'live lockout state — restoring it could lock people out',
  login_ip_failure_tracking:   'live lockout state — restoring it could lock people out',
  vision_api_usage:            'monthly API quota counter — restoring would misstate usage',
  reservation_number_counters: 'locked down by RLS (no client access); rebuilt from reservations by backup_resync_sequences()',
};

export const BACKUP_TABLES = BACKUP_TABLE_CONFIG.map(t => t.name);

const PAGE_SIZE = 1000; // Supabase's default max-rows per request
const BATCH     = 500;  // rows per upsert request

// ─── Small helpers (pure, unit-testable) ─────────────────────────────────────
export function pkColumns(cfg) {
  return Array.isArray(cfg.pk) ? cfg.pk : [cfg.pk];
}

export function conflictTarget(cfg) {
  return cfg.conflict || pkColumns(cfg).join(',');
}

// Splits a table's rows into the first-pass rows (deferred FK columns nulled)
// and the rows that need a second pass once every table exists.
export function splitDeferred(cfg, rows) {
  if (!cfg.defer?.length) return { first: rows, second: [] };

  const second = [];
  const first  = rows.map(row => {
    if (!cfg.defer.some(col => row[col] != null)) return row;
    second.push(row);
    const copy = { ...row };
    cfg.defer.forEach(col => { copy[col] = null; });
    return copy;
  });

  return { first, second };
}

// Works out what a backup file will restore, in dependency order. Also copes
// with older backups (fewer tables) and unknown tables (skipped, reported).
export function buildRestorePlan(bundle) {
  const data       = bundle?.data || {};
  const steps      = [];
  const notRestored = [];

  for (const cfg of BACKUP_TABLE_CONFIG) {
    const rows = data[cfg.name];
    if (!Array.isArray(rows) || !rows.length) continue;
    if (cfg.restore === false) { notRestored.push(cfg.name); continue; }
    steps.push({ cfg, rows });
  }

  const known   = new Set(BACKUP_TABLES);
  const unknown = Object.keys(data).filter(t => !known.has(t) && data[t]?.length);

  return { steps, notRestored, unknown };
}

// Validates a parsed backup bundle BEFORE anything is written to the database.
// A file picked from the computer has no provenance — it may be another app's
// export, a truncated download, or a half-edited file — so it is checked here
// and rejected as a whole rather than failing part-way through a restore.
export function validateBundle(bundle) {
  const fail = message => ({ ok: false, error: message });

  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return fail('The file is not a valid backup object.');
  }
  if (!bundle.meta || typeof bundle.meta !== 'object') {
    return fail('The file is missing its backup header (meta). It was not produced by this system.');
  }
  if (!bundle.data || typeof bundle.data !== 'object' || Array.isArray(bundle.data)) {
    return fail('The file is missing its table data (data). It was not produced by this system.');
  }

  const tableNames = Object.keys(bundle.data);
  if (!tableNames.length) {
    return fail('The backup contains no tables.');
  }

  const notArrays = tableNames.filter(t => !Array.isArray(bundle.data[t]));
  if (notArrays.length) {
    return fail(`These tables are malformed (expected a list of rows): ${notArrays.slice(0, 3).join(', ')}.`);
  }

  const known   = new Set(BACKUP_TABLES);
  const matched = tableNames.filter(t => known.has(t));
  if (!matched.length) {
    return fail('None of the tables in this file belong to this system. It looks like a backup from a different application.');
  }

  const plan = buildRestorePlan(bundle);
  if (!plan.steps.length) {
    return fail('This backup has no restorable rows.');
  }

  const rowCount = tableNames.reduce((sum, t) => sum + bundle.data[t].length, 0);

  return {
    ok: true,
    stats: {
      createdAt:        bundle.meta.created_at || null,
      version:          bundle.meta.version || 'unknown',
      tablesInFile:     tableNames.length,
      tablesRecognised: matched.length,
      tablesToRestore:  plan.steps.length,
      rowCount,
      unknown:          plan.unknown,
    }
  };
}

function describeFailure(table, err) {
  const message = err?.message || String(err);

  if (err?.code === '42501' || /row-level security|permission denied/i.test(message)) {
    return { table, kind: 'blocked', message };
  }
  if (/non-DEFAULT|GENERATED ALWAYS|identity column/i.test(message)) {
    return { table, kind: 'identity', message };
  }
  return { table, kind: 'failed', message };
}

// ─── Read ────────────────────────────────────────────────────────────────────
// PostgREST returns at most max-rows (1000) per request, so a plain select('*')
// silently truncates any bigger table. Page through with a stable sort instead.
async function fetchAllRows(supabase, cfg) {
  const rows = [];
  let total  = null;

  while (total === null || rows.length < total) {
    let query = supabase
      .from(cfg.name)
      .select('*', total === null ? { count: 'exact' } : undefined)
      .range(rows.length, rows.length + PAGE_SIZE - 1);

    for (const col of pkColumns(cfg)) query = query.order(col, { ascending: true });

    const { data, error, count } = await query;
    if (error) return { error };

    if (total === null) total = count ?? Infinity;
    if (!data?.length) break;

    rows.push(...data);
  }

  return { data: rows };
}

export async function readAllTables(supabase, onProgress) {
  const snapshot = {};
  const skipped  = [];

  for (let i = 0; i < BACKUP_TABLE_CONFIG.length; i++) {
    const cfg     = BACKUP_TABLE_CONFIG[i];
    const percent = Math.round((i / BACKUP_TABLE_CONFIG.length) * 70);
    onProgress(percent, `Reading ${cfg.name}…`);

    const { data, error } = await fetchAllRows(supabase, cfg);

    if (error) {
      skipped.push(cfg.name);
      snapshot[cfg.name] = [];
      continue;
    }

    snapshot[cfg.name] = data;
  }

  return { snapshot, skipped };
}

// ─── Restore ─────────────────────────────────────────────────────────────────
async function upsertInBatches(supabase, cfg, rows) {
  for (let b = 0; b < rows.length; b += BATCH) {
    const { error } = await supabase
      .from(cfg.name)
      .upsert(rows.slice(b, b + BATCH), { onConflict: conflictTarget(cfg) });

    if (error) throw error;
  }
}

// One table failing (e.g. RLS blocks the admin role) must not stop the rest, so
// failures are collected and reported instead of thrown.
export async function restoreFromBundle(supabase, bundle, onProgress) {
  const plan = buildRestorePlan(bundle);
  if (!plan.steps.length) throw new Error('This backup has no restorable data.');

  const restored  = [];
  const failures  = [];
  const notes     = [];
  const secondPass = [];

  for (let i = 0; i < plan.steps.length; i++) {
    const { cfg, rows } = plan.steps[i];
    const pct = 20 + Math.round(((i + 1) / plan.steps.length) * 70);
    onProgress(pct, `Restoring ${cfg.name} (${rows.length} rows)…`);

    const { first, second } = splitDeferred(cfg, rows);
    try {
      await upsertInBatches(supabase, cfg, first);
      restored.push(cfg.name);
      if (second.length) secondPass.push({ cfg, rows: second });
    } catch (err) {
      failures.push(describeFailure(cfg.name, err));
    }
  }

  // Second pass: link the deferred references now that every table is in.
  for (const { cfg, rows } of secondPass) {
    onProgress(93, `Linking ${cfg.name} references…`);
    try {
      await upsertInBatches(supabase, cfg, rows);
    } catch (err) {
      failures.push(describeFailure(`${cfg.name} (references)`, err));
    }
  }

  // Sequences/counters can sit behind restored data (fresh database).
  if (plan.steps.some(({ cfg }) => cfg.resync && restored.includes(cfg.name))) {
    onProgress(97, 'Resyncing counters…');
    const { error } = await supabase.rpc('backup_resync_sequences');
    if (error) {
      notes.push('Counters could not be resynced — apply migration 20261015_backup_restore_support.sql.');
    }
  }

  return {
    restored,
    failures,
    notes,
    total:       plan.steps.length,
    notRestored: plan.notRestored,
    unknown:     plan.unknown,
  };
}

// Turns a restore result into one readable sentence for the page banner.
export function summarizeRestore(result) {
  const parts = [];
  const blocked  = result.failures.filter(f => f.kind === 'blocked').map(f => f.table);
  const identity = result.failures.filter(f => f.kind === 'identity').map(f => f.table);
  const failed   = result.failures.filter(f => f.kind === 'failed');

  if (blocked.length)  parts.push(`Blocked by database permissions (this role is read-only on them): ${blocked.join(', ')}.`);
  if (identity.length) parts.push(`Needs migration 20261015_backup_restore_support.sql: ${identity.join(', ')}.`);
  if (failed.length)   parts.push(`Failed: ${failed.map(f => `${f.table} — ${f.message}`).join('; ')}.`);
  if (result.unknown.length) parts.push(`Skipped unknown tables in the file: ${result.unknown.join(', ')}.`);
  result.notes.forEach(n => parts.push(n));

  return parts.join(' ');
}