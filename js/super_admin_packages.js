// super_admin_packages.js
// Bookable inventory: a single filterable Inventory view (category rail +
// card grid / list) replacing the old category-drilldown + package-table
// pages, plus Venues (its own page) and a tier side-drawer.
// Tables: public.package_category, public.package, public.package_tier,
// public.venue, public.package_venue, public.package_photo.
// Image host: Cloudinary (cloud dgneg418t, preset eli_coffee_packages).

import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { getPortalInitials } from './admin_auth.js';
import { initAdminNav } from './admin_nav.js';
import { logAudit } from './audit_logger.js';
import { uploadToCloudinary, destroyCloudinaryImage, validateImageFile, resizeImageFile } from './image_upload.js';

const MAX_PHOTOS_PER_PACKAGE = 8;

// ─── Supabase tables ────────────────────────────────────────────────────────
const CATEGORY_TABLE = 'package_category';
const TIER_TABLE = 'package_tier';
const VENUE_TABLE = 'venue';
const PACKAGE_VENUE_TABLE = 'package_venue';
const PACKAGE_PHOTO_TABLE = 'package_photo';
const BADGE_TABLE = 'badge';
const PACKAGE_BADGE_TABLE = 'package_badge';
const CATERING_CATEGORY_TABLE = 'catering_dish_category';
const CATERING_DISH_TABLE = 'catering_dish';

// ─── State ────────────────────────────────────────────────────────────────────
let allCategories         = [];
let allPackages           = [];
let editingCategoryId     = null;
let editingPackageId      = null;
let pendingAction         = null;
let allTiers              = [];
let editingTierId         = null;
let tierForPackageId      = null;
let tierForPackageName    = '';

// Bookable-inventory additions
let allVenues             = [];
let editingVenueId        = null;
let pendingDeleteAction   = null;   // { scope, id, mode: 'delete'|'archive'|'blocked' }
let pkgPhotos             = [];     // [{ photo_id?, image_url?, file?, alt_text, is_cover, sort_order }]
let pkgInclusions         = [];     // [string, ...]
let pkgVenueIds           = new Set();

// Inventory rebuild: rail/toolbar/health-strip state
let selectedRailCategoryId = null;   // null = All, 'uncategorised', or a real package_category_id
let selectedKind            = '';    // '' | 'main' | 'add on'
let selectedStatus          = 'active'; // 'active' | 'archived'
let viewMode                = 'grid';   // 'grid' | 'list'
let healthFilterActive      = false;
let openCardMenuEl          = null;  // currently-open kebab popover element
let allPackageVenueCounts   = new Map(); // package_id -> mapped venue count
let allTiersByPackage       = new Map(); // package_id -> active tier[]
const archivedRefCountCache = new Map(); // package_id -> reservation reference count (lazy)

// Badges
let allBadgeDefs          = [];          // full badge table (admin sees all, incl. inactive)
let packageBadgeMap       = new Map();   // package_id -> Set(badge_id)  [admin-assigned]
let bestSellerByCategory  = new Map();   // package_category_id -> package_id  [derived]
let badgeModalPackageId   = null;
let editingBadgeTypeId    = null;        // badge_id being edited in the Badge Types view, null = add mode

// Catering menu
let allCateringCategories   = [];        // catering_dish_category rows (for the currently selected package)
let cateringMenuPackages    = [];        // package rows where uses_catering_menu = true
let cateringMenuActivePackageId = null;  // currently selected package_id being managed
let allCateringDishes       = [];        // catering_dish rows (flat, all categories)
let editingCateringCategoryId = null;    // category_id being edited, null = add mode
let cateringDishDrawerCategoryId = null;
let cateringDishDrawerCategoryName = '';
let cateringDishDrawerTriggerEl = null;

// Package-modal dirty-tracking
let pkgFormSnapshot   = null;
let catFormSnapshot   = null;    // same idea as pkgFormSnapshot, for the category modal
let tierDrawerTriggerEl = null;

// ─── DOM: Views ───────────────────────────────────────────────────────────────
const inventoryView    = document.getElementById('inventoryView');
const venueView        = document.getElementById('venueView');
const cateringMenuView = document.getElementById('cateringMenuView');

// ─── DOM: Inventory toolbar / rail / content ──────────────────────────────────
const healthStrip         = document.getElementById('healthStrip');
const healthStripCopy     = document.getElementById('healthStripCopy');
const healthStripAction   = document.getElementById('healthStripAction');
const inventorySearchInput = document.getElementById('inventorySearchInput');
const kindSeg              = document.getElementById('kindSeg');
const statusSeg            = document.getElementById('statusSeg');
const viewSeg              = document.getElementById('viewSeg');
const inventoryPageMessage = document.getElementById('inventoryPageMessage');
const categoryRail         = document.getElementById('categoryRail');
const inventoryGrid        = document.getElementById('inventoryGrid');
const inventoryListWrap    = document.getElementById('inventoryListWrap');
const inventoryListBody    = document.getElementById('inventoryListBody');
const addCategoryBtn       = document.getElementById('addCategoryBtn');
const addPackageBtn        = document.getElementById('addPackageBtn');
const openVenuesBtn        = document.getElementById('openVenuesBtn');

// ─── DOM: Category Modal ──────────────────────────────────────────────────────
const categoryModal      = document.getElementById('categoryModal');
const catModalTitle      = document.getElementById('catModalTitle');
const catModalSub        = document.getElementById('catModalSub');
const catModalClose      = document.getElementById('catModalClose');
const catModalCancel     = document.getElementById('catModalCancel');
const catModalSave       = document.getElementById('catModalSave');
const catModalSaveLabel  = document.getElementById('catModalSaveLabel');
const catModalMessage    = document.getElementById('catModalMessage');
const catNameInput       = document.getElementById('catNameInput');
const catDescriptionInput = document.getElementById('catDescriptionInput');
const catInclusionsInput  = document.getElementById('catInclusionsInput');

// ─── DOM: Package Modal ───────────────────────────────────────────────────────
const packageModal       = document.getElementById('packageModal');
const pkgModalTitle      = document.getElementById('pkgModalTitle');
const pkgModalSub        = document.getElementById('pkgModalSub');
const pkgModalClose      = document.getElementById('pkgModalClose');
const pkgModalCancel     = document.getElementById('pkgModalCancel');
const pkgModalSave       = document.getElementById('pkgModalSave');
const pkgModalSaveLabel  = document.getElementById('pkgModalSaveLabel');
const pkgModalMessage    = document.getElementById('pkgModalMessage');
const pkgUnsavedBanner   = document.getElementById('pkgUnsavedBanner');
const pkgName            = document.getElementById('pkgName');
const pkgNameError       = document.getElementById('pkgNameError');
const pkgType            = document.getElementById('pkgType');
const pkgCategorySelect  = document.getElementById('pkgCategorySelect');
const pkgCategoryHint    = document.getElementById('pkgCategoryHint');
const pkgCategoryError   = document.getElementById('pkgCategoryError');
const pkgDescription     = document.getElementById('pkgDescription');
const pkgPrice           = document.getElementById('pkgPrice');
const pkgPriceError      = document.getElementById('pkgPriceError');
const pkgDuration        = document.getElementById('pkgDuration');
const pkgDurationError   = document.getElementById('pkgDurationError');
const pkgMaxQuantityField= document.getElementById('pkgMaxQuantityField');
const pkgMaxQuantity     = document.getElementById('pkgMaxQuantity');
const pkgMinGuests       = document.getElementById('pkgMinGuests');
const pkgMaxGuests       = document.getElementById('pkgMaxGuests');
const pkgMaxGuestsError  = document.getElementById('pkgMaxGuestsError');
const pkgGuestRangeHint  = document.getElementById('pkgGuestRangeHint');
const pkgExtensionPrice  = document.getElementById('pkgExtensionPrice');
const pkgLocationField   = document.getElementById('pkgLocationField');
const pkgLocationType    = document.getElementById('pkgLocationType');
const pkgVenuesField     = document.getElementById('pkgVenuesField');
const pkgVenuesList      = document.getElementById('pkgVenuesList');
const pkgVenueCapacityHint = document.getElementById('pkgVenueCapacityHint');
const pkgBookingScopeField = document.getElementById('pkgBookingScopeField');
const pkgBookingScope    = document.getElementById('pkgBookingScope');
const pkgPhotosGrid      = document.getElementById('pkgPhotosGrid');
const pkgPhotoInput      = document.getElementById('pkgPhotoInput');
const pkgInclusionsListEl = document.getElementById('pkgInclusionsList');
const pkgAddInclusionBtn = document.getElementById('pkgAddInclusionBtn');
const pkgActivationChecklist = document.getElementById('pkgActivationChecklist');
const pkgActiveToggle    = document.getElementById('pkgActiveToggle');
const pkgUsesCateringMenuToggle = document.getElementById('pkgUsesCateringMenuToggle');

// ─── DOM: Confirm Modal ───────────────────────────────────────────────────────
const confirmModal   = document.getElementById('confirmModal');
const confirmTitle   = document.getElementById('confirmTitle');
const confirmCopy    = document.getElementById('confirmCopy');
const confirmClose   = document.getElementById('confirmClose');
const confirmCancel  = document.getElementById('confirmCancel');
const confirmOk      = document.getElementById('confirmOk');
const confirmMessage = document.getElementById('confirmMessage');

// ─── DOM: Badge Modal ─────────────────────────────────────────────────────────
const badgeModal          = document.getElementById('badgeModal');
const badgeModalClose     = document.getElementById('badgeModalClose');
const badgeModalDone      = document.getElementById('badgeModalDone');
const badgeModalMessage   = document.getElementById('badgeModalMessage');
const badgeBestSellerRow  = document.getElementById('badgeBestSellerRow');
const badgeChipList       = document.getElementById('badgeChipList');

// ─── DOM: Delete/Reassign Modal ───────────────────────────────────────────────
const deleteModal          = document.getElementById('deleteModal');
const deleteModalTitle     = document.getElementById('deleteModalTitle');
const deleteModalCopy      = document.getElementById('deleteModalCopy');
const deleteModalClose     = document.getElementById('deleteModalClose');
const deleteModalCancel    = document.getElementById('deleteModalCancel');
const deleteModalOk        = document.getElementById('deleteModalOk');
const deleteModalMessage   = document.getElementById('deleteModalMessage');
const deleteReassignField  = document.getElementById('deleteReassignField');
const deleteReassignSelect = document.getElementById('deleteReassignSelect');

// ─── DOM: Package tier (Add/Edit form modal) ──────────────────────────────────
const tierModal          = document.getElementById('tierModal');
const tierModalTitle     = document.getElementById('tierModalTitle');
const tierModalSub       = document.getElementById('tierModalSub');
const tierModalClose     = document.getElementById('tierModalClose');
const tierModalCancel    = document.getElementById('tierModalCancel');
const tierModalSave      = document.getElementById('tierModalSave');
const tierModalSaveLabel = document.getElementById('tierModalSaveLabel');
const tierModalMessage   = document.getElementById('tierModalMessage');
const tierNameInput      = document.getElementById('tierName');
const tierSubtitle       = document.getElementById('tierSubtitle');
const tierFullInclusions = document.getElementById('tierFullInclusions');
const tierSortOrder      = document.getElementById('tierSortOrder');

// ─── DOM: Tier drawer (right-anchored, replaces the old below-table panel) ────
const tierDrawerScrim = document.getElementById('tierDrawerScrim');
const tierDrawer      = document.getElementById('tierDrawer');
const tierDrawerTitle = document.getElementById('tierDrawerTitle');
const tierDrawerList  = document.getElementById('tierDrawerList');
const tierDrawerClose = document.getElementById('tierDrawerClose');
const tierDrawerDone  = document.getElementById('tierDrawerDone');
const addTierBtn      = document.getElementById('addTierBtn');

// ─── DOM: Venue View + Modal ──────────────────────────────────────────────────
const addVenueBtn           = document.getElementById('addVenueBtn');
const venuePageMessage      = document.getElementById('venuePageMessage');
const activeVenueSection    = document.getElementById('activeVenueSection');
const archivedVenueSection  = document.getElementById('archivedVenueSection');
const activeVenueBody       = document.getElementById('activeVenueBody');
const archivedVenueBody     = document.getElementById('archivedVenueBody');
const backToCategoriesFromVenuesBtn = document.getElementById('backToCategoriesFromVenuesBtn');

const venueModal          = document.getElementById('venueModal');
const venueModalTitle     = document.getElementById('venueModalTitle');
const venueModalSub       = document.getElementById('venueModalSub');
const venueModalClose     = document.getElementById('venueModalClose');
const venueModalCancel    = document.getElementById('venueModalCancel');
const venueModalSave      = document.getElementById('venueModalSave');
const venueModalSaveLabel = document.getElementById('venueModalSaveLabel');
const venueModalMessage   = document.getElementById('venueModalMessage');
const venueName           = document.getElementById('venueName');
const venueCapacity       = document.getElementById('venueCapacity');
const venueDescription    = document.getElementById('venueDescription');
const venueSortOrder      = document.getElementById('venueSortOrder');
const venueMappedPackagesField = document.getElementById('venueMappedPackagesField');
const venueMappedPackagesList  = document.getElementById('venueMappedPackagesList');

// ─── DOM: Badge Types View + Modal ─────────────────────────────────────────────
const badgeTypesView                 = document.getElementById('badgeTypesView');
const openBadgeTypesBtn              = document.getElementById('openBadgeTypesBtn');
const backToCategoriesFromBadgeTypesBtn = document.getElementById('backToCategoriesFromBadgeTypesBtn');
const addBadgeTypeBtn                = document.getElementById('addBadgeTypeBtn');
const badgeTypesPageMessage          = document.getElementById('badgeTypesPageMessage');
const activeBadgeTypesSection        = document.getElementById('activeBadgeTypesSection');
const archivedBadgeTypesSection      = document.getElementById('archivedBadgeTypesSection');
const activeBadgeTypesBody           = document.getElementById('activeBadgeTypesBody');
const archivedBadgeTypesBody         = document.getElementById('archivedBadgeTypesBody');

const badgeTypeModal          = document.getElementById('badgeTypeModal');
const badgeTypeModalTitle     = document.getElementById('badgeTypeModalTitle');
const badgeTypeModalSub       = document.getElementById('badgeTypeModalSub');
const badgeTypeModalClose     = document.getElementById('badgeTypeModalClose');
const badgeTypeModalCancel    = document.getElementById('badgeTypeModalCancel');
const badgeTypeModalSave      = document.getElementById('badgeTypeModalSave');
const badgeTypeModalSaveLabel = document.getElementById('badgeTypeModalSaveLabel');
const badgeTypeModalMessage   = document.getElementById('badgeTypeModalMessage');
const badgeTypeLabelInput     = document.getElementById('badgeTypeLabelInput');
const badgeTypeVariantSelect  = document.getElementById('badgeTypeVariantSelect');
const badgeTypeScopeSelect    = document.getElementById('badgeTypeScopeSelect');
const badgeTypeSortOrder      = document.getElementById('badgeTypeSortOrder');

// ─── DOM: Catering Menu View + Category Modal + Dish Drawer ───────────────────
const openCateringMenuBtn                 = document.getElementById('openCateringMenuBtn');
const backToCategoriesFromCateringBtn     = document.getElementById('backToCategoriesFromCateringBtn');
const addCateringCategoryBtn              = document.getElementById('addCateringCategoryBtn');
const cateringPageMessage                 = document.getElementById('cateringPageMessage');
const cateringPackagePickerCard           = document.getElementById('cateringPackagePickerCard');
const cateringPackageSelect               = document.getElementById('cateringPackageSelect');
const activeCateringSection               = document.getElementById('activeCateringSection');
const archivedCateringSection             = document.getElementById('archivedCateringSection');
const activeCateringBody                  = document.getElementById('activeCateringBody');
const archivedCateringBody                = document.getElementById('archivedCateringBody');

const cateringCategoryModal          = document.getElementById('cateringCategoryModal');
const cateringCategoryModalTitle     = document.getElementById('cateringCategoryModalTitle');
const cateringCategoryModalSub       = document.getElementById('cateringCategoryModalSub');
const cateringCategoryModalClose     = document.getElementById('cateringCategoryModalClose');
const cateringCategoryModalCancel    = document.getElementById('cateringCategoryModalCancel');
const cateringCategoryModalSave      = document.getElementById('cateringCategoryModalSave');
const cateringCategoryModalSaveLabel = document.getElementById('cateringCategoryModalSaveLabel');
const cateringCategoryModalMessage   = document.getElementById('cateringCategoryModalMessage');
const cateringCatName        = document.getElementById('cateringCatName');
const cateringCatIcon        = document.getElementById('cateringCatIcon');
const cateringCatTag         = document.getElementById('cateringCatTag');
const cateringCatSortOrder   = document.getElementById('cateringCatSortOrder');
const cateringCatRequired    = document.getElementById('cateringCatRequired');
const cateringPrice20        = document.getElementById('cateringPrice20');
const cateringPrice30        = document.getElementById('cateringPrice30');
const cateringPrice40        = document.getElementById('cateringPrice40');
const cateringPrice50        = document.getElementById('cateringPrice50');

const cateringDishDrawer      = document.getElementById('cateringDishDrawer');
const cateringDishDrawerTitle = document.getElementById('cateringDishDrawerTitle');
const cateringDishDrawerList  = document.getElementById('cateringDishDrawerList');
const cateringDishDrawerClose = document.getElementById('cateringDishDrawerClose');
const cateringDishDrawerDone  = document.getElementById('cateringDishDrawerDone');
const cateringDishDrawerMessage = document.getElementById('cateringDishDrawerMessage');
const cateringNewDishInput    = document.getElementById('cateringNewDishInput');
const cateringAddDishBtn      = document.getElementById('cateringAddDishBtn');

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

function formatCurrency(v)  { return `₱${Number(v || 0).toLocaleString()}`; }
function formatCapacity(v)  { return v ? `${v} pax` : '—'; }
function formatDuration(v)  { return v ? `${v} hr${v !== 1 ? 's' : ''}` : '—'; }

function setMessage(el, msg, type = '') {
  el.textContent = msg;
  el.className = 'page-message' + (type ? ` ${type}` : '');
  if (type === 'success') setTimeout(() => { el.textContent = ''; el.className = 'page-message'; }, 4000);
}

function setModalMsg(el, msg, type = 'error') {
  if (!msg) { el.className = 'modal-message hidden'; el.textContent = ''; return; }
  el.textContent = msg;
  el.className = `modal-message ${type}`;
}

function openModal(modal) {
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeModal(modal) {
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}
// one-per-line or comma-separated → stored as newline-separated ──
function normalizeTierInclusions(raw) {
  if (!raw || !raw.trim()) return null;
  return raw
    .split(/[\n,]+/)          // split by newline or comma
    .map(item => item.trim()) // trim each item
    .filter(Boolean)          // remove empty strings
    .join('\n');               // store as newline-separated
}

// ─── Reference counting (delete-vs-archive, mirrors the payment-methods pattern) ─
async function countPackageReservationRefs(packageId) {
  const { count, error } = await supabase
    .from('reservations')
    .select('reservation_id', { count: 'exact', head: true })
    .or(`package_id.eq.${packageId},add_on_id.eq.${packageId}`);
  if (error) throw error;
  return count || 0;
}

async function countCategoryPackageRefs(categoryId) {
  const { count, error } = await supabase
    .from('package')
    .select('package_id', { count: 'exact', head: true })
    .eq('package_category_id', categoryId);
  if (error) throw error;
  return count || 0;
}

async function getVenueMappedPackages(venueId) {
  const { data, error } = await supabase
    .from(PACKAGE_VENUE_TABLE)
    .select('package_id')
    .eq('venue_id', venueId);
  if (error) throw error;
  const ids = (data || []).map(r => r.package_id);
  if (!ids.length) return [];
  const { data: pkgs, error: pkgErr } = await supabase
    .from('package')
    .select('package_id, package_name')
    .in('package_id', ids);
  if (pkgErr) throw pkgErr;
  return pkgs || [];
}

// Lazy, batched reservation reference counts for archived packages — only
// fetched for ids not already cached, so viewing the Archived segment
// repeatedly doesn't re-query.
async function ensureArchivedRefCounts(ids) {
  const missing = ids.filter(id => !archivedRefCountCache.has(id));
  if (!missing.length) return false;
  try {
    const { data, error } = await supabase
      .from('reservations')
      .select('package_id, add_on_id')
      .or(`package_id.in.(${missing.join(',')}),add_on_id.in.(${missing.join(',')})`);
    if (error) throw error;
    const counts = {};
    (data || []).forEach(r => {
      if (r.package_id && missing.includes(r.package_id)) counts[r.package_id] = (counts[r.package_id] || 0) + 1;
      if (r.add_on_id && missing.includes(r.add_on_id)) counts[r.add_on_id] = (counts[r.add_on_id] || 0) + 1;
    });
    missing.forEach(id => archivedRefCountCache.set(id, counts[id] || 0));
  } catch {
    missing.forEach(id => archivedRefCountCache.set(id, 0));
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW SWITCHING
// ═══════════════════════════════════════════════════════════════════════════════
function hideAllViews() {
  inventoryView.style.display    = 'none';
  venueView.style.display        = 'none';
  badgeTypesView.style.display   = 'none';
  cateringMenuView.style.display = 'none';
}

function showInventoryView() {
  hideAllViews();
  inventoryView.style.display = '';
}

async function showVenueView() {
  hideAllViews();
  venueView.style.display = '';
  await loadVenues();
}

function showBadgeTypesView() {
  hideAllViews();
  badgeTypesView.style.display = '';
  renderBadgeTypesTables();
}

async function showCateringMenuView() {
  hideAllViews();
  cateringMenuView.style.display = '';
  await loadCateringMenuPackages();
}

openVenuesBtn.addEventListener('click', showVenueView);
backToCategoriesFromVenuesBtn.addEventListener('click', showInventoryView);
openBadgeTypesBtn.addEventListener('click', showBadgeTypesView);
backToCategoriesFromBadgeTypesBtn.addEventListener('click', showInventoryView);
openCateringMenuBtn.addEventListener('click', showCateringMenuView);
backToCategoriesFromCateringBtn.addEventListener('click', showInventoryView);

// ═══════════════════════════════════════════════════════════════════════════════
// INVENTORY: LOAD (all categories + all packages, batched venue/tier counts)
// ═══════════════════════════════════════════════════════════════════════════════
async function loadCoverPhotosForAllPackages() {
  const ids = allPackages.map(p => p.package_id);
  if (!ids.length) return;
  try {
    const { data, error } = await supabase
      .from(PACKAGE_PHOTO_TABLE)
      .select('package_id, image_url, is_cover')
      .in('package_id', ids)
      .eq('is_cover', true);
    if (error) throw error;
    const byId = {};
    (data || []).forEach(row => { byId[row.package_id] = row.image_url; });
    allPackages.forEach(p => { p._coverImage = byId[p.package_id] || null; });
  } catch {
    // Non-fatal — thumbnails just fall back to the legacy package_image.
  }
}

async function loadInventory() {
  setMessage(inventoryPageMessage, 'Loading inventory…');
  try {
    const [
      { data: cats, error: catErr },
      { data: pkgs, error: pkgErr },
      { data: venueMaps, error: vmErr },
      { data: tiers, error: tierErr },
      { data: venues, error: venueErr },
      { data: badgeDefs, error: badgeErr },
      { data: packageBadgeRows, error: pkgBadgeErr },
      { data: bestSellerRows, error: bestSellerErr }
    ] = await Promise.all([
      supabase.from(CATEGORY_TABLE).select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: false }),
      supabase.from('package').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: false }),
      supabase.from(PACKAGE_VENUE_TABLE).select('package_id'),
      supabase.from(TIER_TABLE).select('*').eq('is_active', true).order('sort_order', { ascending: true }),
      // Bug fix: allVenues used to be populated only by loadVenues(), which
      // only runs when the admin opens the separate Venues screen. Editing
      // a package's venue mappings never triggered that fetch, so
      // renderPkgVenuesList() saw an empty allVenues and rendered "No
      // active venues yet" even though venues existed — silently blocking
      // save for any onsite Main package edited without visiting Venues
      // first. Loading it here means it's always populated before the
      // package modal can open.
      supabase.from(VENUE_TABLE).select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: false }),
      supabase.from(BADGE_TABLE).select('*').order('sort_order', { ascending: true }),
      supabase.from(PACKAGE_BADGE_TABLE).select('package_id, badge_id'),
      // No p_category_id — the admin view loads every category up front, so
      // resolve every category's derived Best Seller in one call.
      supabase.rpc('get_best_seller_package_ids'),
    ]);
    if (catErr) throw catErr;
    if (pkgErr) throw pkgErr;
    if (vmErr) throw vmErr;
    if (tierErr) throw tierErr;
    if (venueErr) throw venueErr;
    if (badgeErr) throw badgeErr;
    if (pkgBadgeErr) throw pkgBadgeErr;
    if (bestSellerErr) throw bestSellerErr;

    allCategories = cats || [];
    allPackages   = pkgs || [];
    allVenues     = venues || [];
    allBadgeDefs  = badgeDefs || [];

    allPackageVenueCounts = new Map();
    (venueMaps || []).forEach(row => {
      allPackageVenueCounts.set(row.package_id, (allPackageVenueCounts.get(row.package_id) || 0) + 1);
    });

    allTiersByPackage = new Map();
    (tiers || []).forEach(t => {
      if (!allTiersByPackage.has(t.package_id)) allTiersByPackage.set(t.package_id, []);
      allTiersByPackage.get(t.package_id).push(t);
    });

    packageBadgeMap = new Map();
    (packageBadgeRows || []).forEach(r => {
      if (!packageBadgeMap.has(r.package_id)) packageBadgeMap.set(r.package_id, new Set());
      packageBadgeMap.get(r.package_id).add(r.badge_id);
    });

    bestSellerByCategory = new Map();
    (bestSellerRows || []).forEach(r => bestSellerByCategory.set(r.package_category_id, r.package_id));

    await loadCoverPhotosForAllPackages();

    renderCategoryRail();
    renderInventory();
    setMessage(inventoryPageMessage, '');
  } catch (err) {
    setMessage(inventoryPageMessage, `Failed to load inventory: ${err.message}`, 'error');
    renderCategoryRail();
    renderInventory();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEALTH STRIP
// ═══════════════════════════════════════════════════════════════════════════════
function computeHealthIssues() {
  const ids = new Set();
  allPackages.forEach(pkg => {
    if (!pkg.is_active) return;
    const isAddon = pkg.package_type === 'add on';
    const hasPhoto = !!(pkg._coverImage || pkg.package_image);
    const isOnsite = pkg.location_type === 'onsite' || pkg.location_type === 'both';
    const needsVenue = !isAddon && isOnsite && !(allPackageVenueCounts.get(pkg.package_id) > 0);
    if (!hasPhoto || needsVenue) ids.add(pkg.package_id);
  });
  return { count: ids.size, ids };
}

function renderHealthStrip() {
  const { count } = computeHealthIssues();
  if (!count) {
    healthStrip.classList.add('hidden');
    healthFilterActive = false;
    return;
  }
  healthStrip.classList.remove('hidden');
  healthStripCopy.textContent = `${count} package${count === 1 ? '' : 's'} can't be booked yet. Missing a photo or a venue assignment keeps them hidden from customers even while active.`;
}

healthStripAction.addEventListener('click', () => {
  healthFilterActive = true;
  inventorySearchInput.value = '';
  selectedKind = '';
  selectedStatus = 'active';
  selectedRailCategoryId = null;
  syncKindSegUI();
  syncStatusSegUI();
  renderCategoryRail();
  renderInventory();
});

function syncKindSegUI() {
  kindSeg.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.kind === selectedKind));
}
function syncStatusSegUI() {
  statusSeg.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.status === selectedStatus));
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY RAIL
// ═══════════════════════════════════════════════════════════════════════════════
function renderCategoryRail() {
  // Guard: if the previously-selected category no longer exists (deleted), fall back to All.
  if (selectedRailCategoryId && selectedRailCategoryId !== 'uncategorised' &&
      !allCategories.some(c => c.package_category_id === selectedRailCategoryId)) {
    selectedRailCategoryId = null;
  }

  const activeCount = allPackages.filter(p => p.is_active).length;
  const uncatCount  = allPackages.filter(p => p.is_active && !p.package_category_id).length;

  const allItem = `
    <button type="button" class="rail-item ${selectedRailCategoryId === null ? 'active' : ''}" data-rail-id="all">
      <span class="rail-swatch" style="background:var(--btn-primary-bg)"></span>
      <span class="rail-item-name">All</span>
      <span class="rail-count">${activeCount}</span>
    </button>`;

  const catItems = allCategories.map(cat => {
    const count = allPackages.filter(p => p.package_category_id === cat.package_category_id && p.is_active).length;
    const isArchived = !cat.is_active;
    const kebabItems = isArchived
      ? `<button type="button" class="card-menu-item" data-cat-action="edit" data-id="${cat.package_category_id}">Edit</button>
         <button type="button" class="card-menu-item" data-cat-action="restore" data-id="${cat.package_category_id}">Restore</button>
         <div class="card-menu-divider"></div>
         <button type="button" class="card-menu-item destructive" data-cat-action="delete" data-id="${cat.package_category_id}">Delete</button>`
      : `<button type="button" class="card-menu-item" data-cat-action="edit" data-id="${cat.package_category_id}">Edit</button>
         <button type="button" class="card-menu-item" data-cat-action="move-up" data-id="${cat.package_category_id}">Move up</button>
         <button type="button" class="card-menu-item" data-cat-action="move-down" data-id="${cat.package_category_id}">Move down</button>
         <div class="card-menu-divider"></div>
         <button type="button" class="card-menu-item" data-cat-action="archive" data-id="${cat.package_category_id}">Archive</button>
         <div class="card-menu-divider"></div>
         <button type="button" class="card-menu-item destructive" data-cat-action="delete" data-id="${cat.package_category_id}">Delete</button>`;
    return `
      <div class="rail-item-wrap card-menu">
        <button type="button" class="rail-item ${selectedRailCategoryId === cat.package_category_id ? 'active' : ''} ${isArchived ? 'is-archived' : ''}" data-rail-id="${cat.package_category_id}">
          <span class="rail-swatch"></span>
          <span class="rail-item-name">${escapeHtml(cat.category_name)}${isArchived ? ' (archived)' : ''}</span>
          <span class="rail-count">${count}</span>
        </button>
        <button type="button" class="icon-btn" data-menu-trigger aria-haspopup="true" aria-expanded="false" aria-label="More actions for ${escapeHtml(cat.category_name)}">⋮</button>
        <div class="card-menu-popover" hidden>${kebabItems}</div>
      </div>`;
  }).join('');

  const uncatItem = `
    <button type="button" class="rail-item ${uncatCount > 0 ? 'rail-flag' : ''} ${selectedRailCategoryId === 'uncategorised' ? 'active' : ''}" data-rail-id="uncategorised">
      <span class="rail-swatch" style="background:var(--muted-2)"></span>
      <span class="rail-item-name">Uncategorised</span>
      <span class="rail-count">${uncatCount}</span>
    </button>`;

  categoryRail.innerHTML = allItem + catItems + uncatItem;
}

categoryRail.addEventListener('click', (e) => {
  const menuTrigger = e.target.closest('[data-menu-trigger]');
  if (menuTrigger) {
    const popover = menuTrigger.nextElementSibling;
    const isOpen = openCardMenuEl === popover;
    closeOpenCardMenu();
    if (!isOpen) {
      popover.hidden = false;
      menuTrigger.setAttribute('aria-expanded', 'true');
      openCardMenuEl = popover;
      positionRailPopover(popover, menuTrigger);
    }
    return;
  }
  const catActionBtn = e.target.closest('[data-cat-action]');
  if (catActionBtn) {
    closeOpenCardMenu();
    handleCatTableAction(e);
    return;
  }
  const railBtn = e.target.closest('.rail-item[data-rail-id]');
  if (railBtn) {
    const id = railBtn.dataset.railId;
    selectedRailCategoryId = id === 'all' ? null : id;
    healthFilterActive = false;
    renderCategoryRail();
    renderInventory();
  }
});

// The category rail scrolls its own contents (overflow-y: auto), which
// clips the popover's default CSS positioning (absolute, relative to the
// narrow rail row) — it visually gets cut off inside that row instead of
// floating over the page. Fixed-positioning it from the trigger's real
// on-screen coordinates escapes that clipping entirely.
function positionRailPopover(popover, trigger) {
  const rect = trigger.getBoundingClientRect();
  popover.style.position = 'fixed';
  popover.style.top = '0px';
  popover.style.bottom = 'auto';
  popover.style.left = '0px';
  popover.style.right = 'auto'; 

  const popRect = popover.getBoundingClientRect(); 
  const spaceBelow = window.innerHeight - rect.bottom;
  const openUpward = spaceBelow < popRect.height + 12 && rect.top > popRect.height + 12;

  if (openUpward) {
    popover.style.top = 'auto';
    popover.style.bottom = `${window.innerHeight - rect.top + 4}px`;
  } else {
    popover.style.top = `${rect.bottom + 4}px`;
    popover.style.bottom = 'auto';
  }

  let leftPos = rect.right - popRect.width;
  if (leftPos < 8) leftPos = 8;
  popover.style.left = `${leftPos}px`;
  // Escaping to fixed positioning moves this into the root stacking
  // context, where the admin sidebar/topbar (z-index up to 500) would
  // otherwise sit on top of it.
  popover.style.zIndex = '600';
}

// A fixed-position popover doesn't track the rail scrolling beneath it, so
// close it rather than leave it visually detached from its trigger.
categoryRail.addEventListener('scroll', () => {
  if (openCardMenuEl && categoryRail.contains(openCardMenuEl)) closeOpenCardMenu();
});

// ═══════════════════════════════════════════════════════════════════════════════
// KEBAB MENU (shared: package cards, list rows, category rail items)
// ═══════════════════════════════════════════════════════════════════════════════
function closeOpenCardMenu() {
  if (openCardMenuEl) {
    openCardMenuEl.hidden = true;
    openCardMenuEl.style.position = '';
    openCardMenuEl.style.top = '';
    openCardMenuEl.style.bottom = '';
    openCardMenuEl.style.left = '';
    openCardMenuEl.style.right = '';
    openCardMenuEl.style.zIndex = '';
    const trigger = openCardMenuEl.previousElementSibling;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    openCardMenuEl = null;
  }
}

document.addEventListener('click', (e) => {
  if (openCardMenuEl && !e.target.closest('.card-menu')) closeOpenCardMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openCardMenuEl) closeOpenCardMenu();
});

function buildCardMenu(pkg) {
  const isArchived = !pkg.is_active;
  const isAddon = pkg.package_type === 'add on';
  const items = isArchived
    ? [
        { action: 'edit', label: 'Edit' },
        { action: 'delete', label: 'Delete', destructive: true },
      ]
    : [
        { action: 'duplicate', label: 'Duplicate' },
        ...(isAddon ? [] : [{ action: 'tiers', label: 'Tiers' }, { action: 'badges', label: 'Badges' }]),
        { divider: true },
        { action: 'move-up', label: 'Move up' },
        { action: 'move-down', label: 'Move down' },
        { divider: true },
        { action: 'archive', label: 'Archive' },
        { action: 'delete', label: 'Delete', destructive: true },
      ];
  const itemsHtml = items.map(it => {
    if (it.divider) return '<div class="card-menu-divider"></div>';
    return `<button type="button" class="card-menu-item ${it.destructive ? 'destructive' : ''}" data-pkg-action="${it.action}" data-id="${pkg.package_id}" data-name="${escapeHtml(pkg.package_name)}">${it.label}</button>`;
  }).join('');
  return `
    <div class="card-menu">
      <button type="button" class="icon-btn" data-menu-trigger aria-haspopup="true" aria-expanded="false" aria-label="More actions for ${escapeHtml(pkg.package_name)}">⋮</button>
      <div class="card-menu-popover" hidden>${itemsHtml}</div>
    </div>`;
}

function handleInventoryClick(e) {
  const trigger = e.target.closest('[data-menu-trigger]');
  if (trigger) {
    const popover = trigger.nextElementSibling;
    const isOpen = openCardMenuEl === popover;
    closeOpenCardMenu();
    if (!isOpen) { popover.hidden = false; trigger.setAttribute('aria-expanded', 'true'); openCardMenuEl = popover; }
    return;
  }
  if (e.target.closest('[data-pkg-action]')) {
    closeOpenCardMenu();
    handlePkgTableAction(e);
    return;
  }
  closeOpenCardMenu();
}

inventoryGrid.addEventListener('click', handleInventoryClick);
inventoryListBody.addEventListener('click', handleInventoryClick);

// ═══════════════════════════════════════════════════════════════════════════════
// INVENTORY: FILTER + RENDER
// ═══════════════════════════════════════════════════════════════════════════════
function guestRangeLabel(pkg) {
  const min = pkg.min_guests;
  const max = pkg.max_guests ?? pkg.guest_capacity;
  if (min && max) return `${min}–${max} pax`;
  return formatCapacity(max);
}

function buildPkgThumb(pkg) {
  const cover = pkg._coverImage || pkg.package_image;
  if (cover) {
    return `<div class="pkg-thumb"><img src="${escapeHtml(cover)}" alt="${escapeHtml(pkg.package_name)}" loading="lazy"></div>`;
  }
  return `<div class="pkg-thumb">
    <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
      <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
    </svg>
  </div>`;
}

function buildTierLadder(pkg) {
  if (pkg.package_type === 'add on') {
    return `<p class="tier-ladder">Add-ons don't use tiers</p>`;
  }
  const tiers = allTiersByPackage.get(pkg.package_id) || [];
  if (!tiers.length) {
    return `<p class="tier-ladder"><button type="button" class="tier-ladder-link" data-pkg-action="tiers" data-id="${pkg.package_id}" data-name="${escapeHtml(pkg.package_name)}">No tiers set — Add tiers</button></p>`;
  }
  const bars = tiers.slice(0, 3).map(() => '<span class="tier-ladder-bar"></span>').join('');
  return `<p class="tier-ladder"><span class="tier-ladder-bars">${bars}</span>&nbsp;${tiers.length} tier${tiers.length === 1 ? '' : 's'} · <button type="button" class="tier-ladder-link" data-pkg-action="tiers" data-id="${pkg.package_id}" data-name="${escapeHtml(pkg.package_name)}">Manage</button></p>`;
}

// Assigned badges (package_badge) + Best Seller for this category — add-ons
// never carry badges (matches the precedent of the hardcode this replaces,
// which only ever computed "best value" over main packages). Best Seller is
// mode-aware: automatic (is_assignable=false) overlays the derived winner
// from bestSellerByCategory; manual (is_assignable=true) treats it like any
// other assigned badge, so it only appears once an admin has toggled it on
// for a specific package via the badge modal.
function getPkgBadges(pkg) {
  if (pkg.package_type === 'add on') return [];
  const assignedIds = packageBadgeMap.get(pkg.package_id) || new Set();
  const bs = allBadgeDefs.find(b => b.badge_key === 'best_seller');
  const candidates = allBadgeDefs.filter(b => b.badge_key !== 'best_seller' && assignedIds.has(b.badge_id));
  if (bs) {
    if (bs.is_assignable) {
      if (assignedIds.has(bs.badge_id)) candidates.push(bs);
    } else if (bestSellerByCategory.get(pkg.package_category_id) === pkg.package_id) {
      candidates.push(bs);
    }
  }
  return candidates.sort((a, b) => a.sort_order - b.sort_order).slice(0, 2);
}

function buildBadgeChipsHtml(pkg) {
  const badges = getPkgBadges(pkg);
  if (!badges.length) return '';
  return `<div class="pkg-badges-row">${badges.map(b =>
    `<span class="pkg-badge-chip pkg-badge-chip--${escapeHtml(b.variant)}">${escapeHtml(b.label)}</span>`
  ).join('')}</div>`;
}

function archivedReasonLine(pkg) {
  const count = archivedRefCountCache.get(pkg.package_id);
  if (count === undefined) return `<p class="tier-ladder">Archived</p>`;
  if (count === 0) return `<p class="tier-ladder">Not used on any booking</p>`;
  return `<p class="tier-ladder">Kept on ${count} past booking${count === 1 ? '' : 's'}</p>`;
}

function buildPkgCard(pkg) {
  const isArchived = !pkg.is_active;
  const isAddon = pkg.package_type === 'add on';
  const isOffsite = pkg.location_type === 'offsite';
  const needsVenue = !isArchived && !isAddon && (pkg.location_type === 'onsite' || pkg.location_type === 'both') && !(allPackageVenueCounts.get(pkg.package_id) > 0);
  const cat = allCategories.find(c => c.package_category_id === pkg.package_category_id);
  const catLabel = cat ? cat.category_name : 'Uncategorised';
  const modeLabel = isAddon
    ? 'Add-on'
    : pkg.location_type === 'onsite' ? 'Onsite'
    : pkg.location_type === 'offsite' ? 'Travels to you'
    : pkg.location_type === 'both' ? 'Onsite or travels'
    : '—';

  const flags = [];
  if (needsVenue) flags.push('<span class="pkg-flag flag-warn">Needs venue</span>');
  if (isOffsite) flags.push('<span class="pkg-flag flag-neutral">Offsite</span>');
  if (isArchived) flags.push('<span class="pkg-flag flag-archived">Archived</span>');

  const photo = pkg._coverImage || pkg.package_image;
  const photoHtml = photo
    ? `<img class="pkg-card-photo" src="${escapeHtml(photo)}" alt="${escapeHtml(pkg.package_name)}" loading="lazy">`
    : `<div class="pkg-card-photo-empty">No photo</div>`;

  const inlineAction = isArchived
    ? `<button type="button" class="pkg-card-icon-btn" data-pkg-action="restore" data-id="${pkg.package_id}" aria-label="Restore ${escapeHtml(pkg.package_name)}">↺</button>`
    : `<button type="button" class="pkg-card-icon-btn" data-pkg-action="edit" data-id="${pkg.package_id}" aria-label="Edit ${escapeHtml(pkg.package_name)}">✎</button>`;

  return `
    <div class="pkg-card ${isArchived ? 'is-archived' : ''}" data-package-id="${pkg.package_id}">
      <div class="pkg-card-photo-wrap">
        ${photoHtml}
        <div class="pkg-card-flags">${flags.join('')}</div>
        <div class="pkg-card-actions">
          ${inlineAction}
          ${buildCardMenu(pkg)}
        </div>
      </div>
      <div class="pkg-card-body">
        <div class="pkg-card-name">${escapeHtml(pkg.package_name)}</div>
        ${buildBadgeChipsHtml(pkg)}
        <p class="pkg-card-meta">${escapeHtml(catLabel)} · ${escapeHtml(modeLabel)}</p>
        <div class="pkg-spec-line">
          <span class="pkg-spec-price">${formatCurrency(pkg.price)}</span>
          <span class="spec-leader"></span>
          <span class="spec-figures">${escapeHtml(guestRangeLabel(pkg))} · ${escapeHtml(formatDuration(pkg.duration_hours))}</span>
        </div>
        ${isArchived ? archivedReasonLine(pkg) : buildTierLadder(pkg)}
      </div>
    </div>`;
}

function buildPkgListRow(pkg) {
  const isArchived = !pkg.is_active;
  const cat = allCategories.find(c => c.package_category_id === pkg.package_category_id);
  const catLabel = cat ? cat.category_name : 'Uncategorised';
  const needsVenue = !isArchived && pkg.package_type !== 'add on' &&
    (pkg.location_type === 'onsite' || pkg.location_type === 'both') && !(allPackageVenueCounts.get(pkg.package_id) > 0);

  const inlineAction = isArchived
    ? `<button type="button" class="action-btn edit" data-pkg-action="restore" data-id="${pkg.package_id}">Restore</button>`
    : `<button type="button" class="action-btn edit" data-pkg-action="edit" data-id="${pkg.package_id}">Edit</button>`;

  return `<tr>
    <td>
      <div class="pkg-cell">
        ${buildPkgThumb(pkg)}
        <div>
          <div class="pkg-name">${escapeHtml(pkg.package_name)}</div>
          <div>
            ${isArchived ? '<span class="status-pill archived">Archived</span>' : ''}
            ${needsVenue ? '<span class="pkg-flag flag-warn">Needs venue</span>' : ''}
          </div>
          ${buildBadgeChipsHtml(pkg)}
        </div>
      </div>
    </td>
    <td>${escapeHtml(catLabel)}</td>
    <td>${escapeHtml(formatCurrency(pkg.price))}</td>
    <td>${escapeHtml(guestRangeLabel(pkg))}</td>
    <td>${buildTierLadder(pkg)}</td>
    <td>
      <div class="list-actions">
        ${inlineAction}
        ${buildCardMenu(pkg)}
      </div>
    </td>
  </tr>`;
}

function emptyStateCopy() {
  if (healthFilterActive) return "Nothing left to fix — the health strip will clear once this reloads.";
  if (selectedStatus === 'archived') return 'No archived packages here yet.';
  const catNote = selectedRailCategoryId === 'uncategorised' ? ' in Uncategorised' : selectedRailCategoryId ? ' in this category' : '';
  return `No packages${catNote} yet. Add one so customers have something to book.`;
}

function getFilteredInventory() {
  const term = (inventorySearchInput.value || '').trim().toLowerCase();

  if (healthFilterActive) {
    const { ids } = computeHealthIssues();
    return allPackages.filter(p => ids.has(p.package_id));
  }

  return allPackages.filter(pkg => {
    const isActive = selectedStatus === 'active';
    if (Boolean(pkg.is_active) !== isActive) return false;
    if (selectedKind && pkg.package_type !== selectedKind) return false;
    if (selectedRailCategoryId === 'uncategorised') {
      if (pkg.package_category_id) return false;
    } else if (selectedRailCategoryId) {
      if (pkg.package_category_id !== selectedRailCategoryId) return false;
    }
    if (term) {
      const hay = `${pkg.package_name} ${pkg.package_type} ${pkg.description || ''}`.toLowerCase();
      if (!hay.includes(term)) return false;
    }
    return true;
  });
}

function renderInventory() {
  const filtered = getFilteredInventory();

  if (viewMode === 'grid') {
    inventoryGrid.classList.remove('hidden');
    inventoryListWrap.classList.add('hidden');
    inventoryGrid.innerHTML = filtered.length
      ? filtered.map(buildPkgCard).join('')
      : `<p class="page-message">${emptyStateCopy()}</p>`;
  } else {
    inventoryGrid.classList.add('hidden');
    inventoryListWrap.classList.remove('hidden');
    inventoryListBody.innerHTML = filtered.length
      ? filtered.map(buildPkgListRow).join('')
      : `<tr class="empty-row"><td colspan="6">${emptyStateCopy()}</td></tr>`;
  }

  renderHealthStrip();

  if (selectedStatus === 'archived' && filtered.length) {
    ensureArchivedRefCounts(filtered.map(p => p.package_id)).then(changed => {
      if (changed) renderInventory();
    });
  }
}

kindSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  selectedKind = btn.dataset.kind;
  healthFilterActive = false;
  syncKindSegUI();
  renderInventory();
});

statusSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  selectedStatus = btn.dataset.status;
  healthFilterActive = false;
  syncStatusSegUI();
  renderInventory();
});

viewSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  viewMode = btn.dataset.view;
  viewSeg.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
  renderInventory();
});

inventorySearchInput.addEventListener('input', () => { healthFilterActive = false; renderInventory(); });

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY: MODAL (Add / Edit)
// ═══════════════════════════════════════════════════════════════════════════════
function openAddCategoryModal() {
  editingCategoryId   = null;
  catModalTitle.textContent     = 'Add New Category';
  catModalSub.textContent       = 'Create a new package category';
  catModalSaveLabel.textContent = 'Add Category';
  catNameInput.value = '';
  catDescriptionInput.value = '';
  catInclusionsInput.value  = '';
  setModalMsg(catModalMessage, '');
  openModal(categoryModal);
  snapshotCatForm();
}

function openEditCategoryModal(catId) {
  const cat = allCategories.find(c => c.package_category_id === catId);
  if (!cat) return;

  editingCategoryId   = catId;
  catModalTitle.textContent     = 'Edit Category';
  catModalSub.textContent       = 'Update category details';
  catModalSaveLabel.textContent = 'Save Changes';
  catNameInput.value = cat.category_name || '';
  catDescriptionInput.value = cat.description || '';
  catInclusionsInput.value  = cat.package_category_inclusions || '';

  setModalMsg(catModalMessage, '');
  openModal(categoryModal);
  snapshotCatForm();
}

// ── Category modal: unsaved-changes guard (same pattern as the package modal) ──
function getCatFormState() {
  return JSON.stringify({
    name: catNameInput.value,
    description: catDescriptionInput.value,
    inclusions: catInclusionsInput.value,
  });
}

function snapshotCatForm() {
  catFormSnapshot = getCatFormState();
}

function isCatFormDirty() {
  if (catFormSnapshot === null) return false;
  return getCatFormState() !== catFormSnapshot;
}

function attemptCloseCategoryModal() {
  if (isCatFormDirty()) {
    pendingAction = { scope: 'discard-category-changes' };
    confirmTitle.textContent = 'Discard Unsaved Changes?';
    confirmCopy.textContent  = 'You have unsaved changes to this category. Closing now will discard them.';
    confirmOk.textContent    = 'Discard Changes';
    confirmOk.className      = 'btn-danger';
    setModalMsg(confirmMessage, '');
    openModal(confirmModal);
    return;
  }
  catFormSnapshot = null;
  closeModal(categoryModal);
}

// Category save
catModalSave.addEventListener('click', async () => {
  const name = catNameInput.value.trim();
  const description = catDescriptionInput.value.trim();
  const inclusions  = catInclusionsInput.value.trim();

  if (!name) { setModalMsg(catModalMessage, 'Category name is required.'); return; }

  catModalSave.disabled = true;
  catModalSaveLabel.textContent = 'Saving…';
  setModalMsg(catModalMessage, '');

  try {
    const payload = {
      category_name: name,
      description: description,
      package_category_inclusions: inclusions
    };

    if (editingCategoryId) {
      const { data, error } = await supabase
        .from(CATEGORY_TABLE)
        .update(payload)
        .eq('package_category_id', editingCategoryId)
        .select()
        .single();
      if (error) throw error;
      const idx = allCategories.findIndex(c => c.package_category_id === editingCategoryId);
      if (idx !== -1) allCategories[idx] = data;
      await logAudit({
        action:   'Updated Category',
        category: 'package',
        details:  `Category updated: ${name}`,
        entityId: editingCategoryId
      });
      setMessage(inventoryPageMessage, 'Category updated successfully.', 'success');
    } else {
      payload.is_active = true;
      const { data, error } = await supabase
        .from(CATEGORY_TABLE)
        .insert(payload)
        .select()
        .single();
      if (error) throw error;
      allCategories.unshift(data);
      await logAudit({
        action:   'Added Category',
        category: 'package',
        details:  `New category created: ${name}`,
        entityId: data.package_category_id
      });
      setMessage(inventoryPageMessage, 'Category added successfully.', 'success');
    }

    renderCategoryRail();
    renderInventory();
    catFormSnapshot = null;
    closeModal(categoryModal);

  } catch (err) {
    setModalMsg(catModalMessage, `Failed to save: ${err.message}`);
  } finally {
    catModalSave.disabled = false;
    catModalSaveLabel.textContent = editingCategoryId ? 'Save Changes' : 'Add Category';
  }
});

addCategoryBtn.addEventListener('click', openAddCategoryModal);
catModalClose.addEventListener('click',  attemptCloseCategoryModal);
catModalCancel.addEventListener('click', attemptCloseCategoryModal);
categoryModal.addEventListener('click', e => { if (e.target === categoryModal) attemptCloseCategoryModal(); });

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY: ARCHIVE / RESTORE / DELETE
// ═══════════════════════════════════════════════════════════════════════════════
function openConfirmArchiveCategory(catId) {
  const cat = allCategories.find(c => c.package_category_id === catId);
  if (!cat) return;
  pendingAction = { scope: 'category', type: 'archive', id: catId };
  confirmTitle.textContent = 'Archive Category';
  confirmCopy.textContent  = `Are you sure you want to archive "${cat.category_name}"? It and its packages will no longer be visible to customers.`;
  confirmOk.textContent    = 'Archive';
  confirmOk.className      = 'btn-danger';
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

function openConfirmRestoreCategory(catId) {
  const cat = allCategories.find(c => c.package_category_id === catId);
  if (!cat) return;
  pendingAction = { scope: 'category', type: 'restore', id: catId };
  confirmTitle.textContent = 'Restore Category';
  confirmCopy.textContent  = `Restore "${cat.category_name}" and make it visible to customers again?`;
  confirmOk.textContent    = 'Restore';
  confirmOk.className      = 'btn-primary';
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

// Category delete: blocked while any package references it — offer
// reassignment to another active category rather than a dead end.
async function openConfirmDeleteCategory(catId) {
  const cat = allCategories.find(c => c.package_category_id === catId);
  if (!cat) return;

  setMessage(inventoryPageMessage, 'Checking packages…');
  let count;
  try {
    count = await countCategoryPackageRefs(catId);
  } catch (err) {
    setMessage(inventoryPageMessage, `Failed to check packages: ${err.message}`, 'error');
    return;
  }
  setMessage(inventoryPageMessage, '');

  pendingDeleteAction = { scope: 'category', id: catId };
  deleteModalOk.disabled = false;

  if (count > 0) {
    const others = allCategories.filter(c => c.package_category_id !== catId && c.is_active);
    deleteReassignField.classList.remove('hidden');
    deleteReassignSelect.innerHTML = others
      .map(c => `<option value="${c.package_category_id}">${escapeHtml(c.category_name)}</option>`)
      .join('');

    deleteModalTitle.textContent = 'Category In Use';
    if (others.length) {
      deleteModalCopy.textContent = `${count} package${count === 1 ? '' : 's'} use "${cat.category_name}". Choose a category to reassign them to, or Cancel and use Archive instead.`;
    } else {
      deleteModalCopy.textContent = `${count} package${count === 1 ? '' : 's'} use "${cat.category_name}", and there's no other active category to reassign them to. Cancel and use Archive instead, or create another category first.`;
      deleteModalOk.disabled = true;
    }
  } else {
    deleteReassignField.classList.add('hidden');
    deleteModalTitle.textContent = 'Delete Category';
    deleteModalCopy.textContent = `Delete "${cat.category_name}"? This can't be undone.`;
  }

  deleteModalOk.textContent = 'Delete';
  setModalMsg(deleteModalMessage, '');
  openModal(deleteModal);
}

// Categories, unlike packages, aren't scoped to anything narrower than "all
// active categories" — so reordering just works against the full active list.
function getActiveCategoriesSorted() {
  return allCategories
    .filter(c => c.is_active)
    .sort((a, b) => (a.sort_order - b.sort_order) || (new Date(b.created_at) - new Date(a.created_at)));
}

async function moveCategory(categoryId, direction) {
  const cat = allCategories.find(c => c.package_category_id === categoryId);
  if (!cat || !cat.is_active) return;

  const list = getActiveCategoriesSorted();
  const index = list.findIndex(c => c.package_category_id === categoryId);
  const targetIndex = index + direction;
  if (index === -1 || targetIndex < 0 || targetIndex >= list.length) return;

  [list[index], list[targetIndex]] = [list[targetIndex], list[index]];

  setMessage(inventoryPageMessage, 'Reordering…');
  try {
    await Promise.all(list.map((c, i) => {
      if (c.sort_order === i) return Promise.resolve();
      c.sort_order = i;
      return supabase.from(CATEGORY_TABLE).update({ sort_order: i }).eq('package_category_id', c.package_category_id);
    }));
    await logAudit({
      action: 'Reordered Categories',
      category: 'package',
      details: `Moved "${cat.category_name}" ${direction < 0 ? 'up' : 'down'}`,
      entityId: categoryId
    });
    setMessage(inventoryPageMessage, 'Order updated.', 'success');
    renderCategoryRail();
    renderInventory();
  } catch (err) {
    setMessage(inventoryPageMessage, `Failed to reorder: ${err.message}`, 'error');
  }
}

function handleCatTableAction(e) {
  const btn = e.target.closest('[data-cat-action]');
  if (!btn) return;
  const { catAction, id } = btn.dataset;
  if (catAction === 'edit')      openEditCategoryModal(id);
  if (catAction === 'archive')   openConfirmArchiveCategory(id);
  if (catAction === 'restore')   openConfirmRestoreCategory(id);
  if (catAction === 'delete')    openConfirmDeleteCategory(id);
  if (catAction === 'move-up')   moveCategory(id, -1);
  if (catAction === 'move-down') moveCategory(id, 1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PACKAGE: DUPLICATE
// ═══════════════════════════════════════════════════════════════════════════════
// Duplicate: clone a package's fields (+ inclusions + venue mappings), not
// its photos (Cloudinary assets aren't cheap to fork silently) or reservations.
// Starts inactive so the admin reviews it before it goes live.
async function duplicatePackage(packageId) {
  const pkg = allPackages.find(p => p.package_id === packageId);
  if (!pkg) return;
  setMessage(inventoryPageMessage, 'Duplicating…');
  try {
    const clonePayload = { ...pkg };
    delete clonePayload.package_id;
    delete clonePayload.created_at;
    delete clonePayload._coverImage;
    clonePayload.package_name = `${pkg.package_name} (Copy)`;
    clonePayload.is_active = false;
    clonePayload.package_image = null;

    const { data, error } = await supabase.from('package').insert(clonePayload).select().single();
    if (error) throw error;

    const { data: venueRows } = await supabase.from(PACKAGE_VENUE_TABLE).select('venue_id').eq('package_id', packageId);
    if (venueRows && venueRows.length) {
      await supabase.from(PACKAGE_VENUE_TABLE).insert(venueRows.map(v => ({ package_id: data.package_id, venue_id: v.venue_id })));
      allPackageVenueCounts.set(data.package_id, venueRows.length);
    }

    allPackages.unshift(data);
    await logAudit({
      action: 'Duplicated Package',
      category: 'package',
      details: `Duplicated "${pkg.package_name}" as "${clonePayload.package_name}"`,
      entityId: data.package_id
    });
    renderCategoryRail();
    renderInventory();
    setMessage(inventoryPageMessage, 'Package duplicated — review and activate it when ready.', 'success');
  } catch (err) {
    setMessage(inventoryPageMessage, `Failed to duplicate: ${err.message}`, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PACKAGE: PHOTOS (in-modal state)
// ═══════════════════════════════════════════════════════════════════════════════
function renderPkgPhotosGrid() {
  if (!pkgPhotos.length) {
    pkgPhotosGrid.innerHTML = '<p class="modal-hint">No photos yet.</p>';
  } else {
    pkgPhotosGrid.innerHTML = pkgPhotos.map((photo, index) => {
      const src = photo._localPreview || photo.image_url || '';
      return `
        <div class="photo-grid-item ${photo.is_cover ? 'is-cover' : ''}" data-index="${index}">
          <img src="${escapeHtml(src)}" alt="">
          <div class="photo-grid-controls">
            <button type="button" data-photo-action="cover" class="${photo.is_cover ? 'active' : ''}" title="Set as cover">★</button>
            <button type="button" data-photo-action="left" title="Move left">‹</button>
            <button type="button" data-photo-action="right" title="Move right">›</button>
            <button type="button" data-photo-action="remove" title="Remove">✕</button>
          </div>
          <input type="text" class="photo-alt-input" data-photo-alt-index="${index}" placeholder="Alt text (required)" value="${escapeHtml(photo.alt_text || '')}">
        </div>
      `;
    }).join('');
  }
  updateUnsavedBanner();
}

pkgPhotosGrid.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-photo-action]');
  if (!btn) return;
  const item = btn.closest('[data-index]');
  const index = Number(item.dataset.index);
  const action = btn.dataset.photoAction;

  if (action === 'cover') {
    pkgPhotos.forEach((p, i) => { p.is_cover = i === index; });
  } else if (action === 'remove') {
    pkgPhotos.splice(index, 1);
    if (pkgPhotos.length && !pkgPhotos.some(p => p.is_cover)) pkgPhotos[0].is_cover = true;
  } else if (action === 'left' && index > 0) {
    [pkgPhotos[index - 1], pkgPhotos[index]] = [pkgPhotos[index], pkgPhotos[index - 1]];
  } else if (action === 'right' && index < pkgPhotos.length - 1) {
    [pkgPhotos[index + 1], pkgPhotos[index]] = [pkgPhotos[index], pkgPhotos[index + 1]];
  }
  pkgPhotos.forEach((p, i) => { p.sort_order = i; });
  renderPkgPhotosGrid();
  renderActivationChecklist();
});

pkgPhotosGrid.addEventListener('input', (e) => {
  const input = e.target.closest('[data-photo-alt-index]');
  if (!input) return;
  const index = Number(input.dataset.photoAltIndex);
  if (pkgPhotos[index]) pkgPhotos[index].alt_text = input.value;
  renderActivationChecklist();
});

pkgPhotoInput.addEventListener('change', async () => {
  const files = Array.from(pkgPhotoInput.files || []);
  pkgPhotoInput.value = '';
  if (!files.length) return;

  for (const file of files) {
    if (pkgPhotos.length >= MAX_PHOTOS_PER_PACKAGE) {
      setModalMsg(pkgModalMessage, `Maximum ${MAX_PHOTOS_PER_PACKAGE} photos per package.`);
      break;
    }
    const err = validateImageFile(file);
    if (err) { setModalMsg(pkgModalMessage, err); continue; }
    const resized = await resizeImageFile(file);
    const localPreview = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.readAsDataURL(resized);
    });
    pkgPhotos.push({
      file: resized,
      _localPreview: localPreview,
      alt_text: '',
      is_cover: pkgPhotos.length === 0,
      sort_order: pkgPhotos.length
    });
  }
  renderPkgPhotosGrid();
  renderActivationChecklist();
});

// ═══════════════════════════════════════════════════════════════════════════════
// PACKAGE: INCLUSIONS (structured list, in-modal state)
// ═══════════════════════════════════════════════════════════════════════════════
function renderPkgInclusionsList() {
  if (!pkgInclusions.length) {
    pkgInclusionsListEl.innerHTML = '<p class="modal-hint">No inclusions yet — add at least one.</p>';
  } else {
    pkgInclusionsListEl.innerHTML = pkgInclusions.map((item, index) => `
      <div class="inclusion-row" data-index="${index}">
        <button type="button" class="reorder-btn" data-inclusion-action="up" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="reorder-btn" data-inclusion-action="down" ${index === pkgInclusions.length - 1 ? 'disabled' : ''}>↓</button>
        <input type="text" data-inclusion-index="${index}" value="${escapeHtml(item)}" placeholder="e.g. 3-hour venue use">
        <button type="button" data-inclusion-action="remove" title="Remove">✕</button>
      </div>
    `).join('');
  }
  updateUnsavedBanner();
}

pkgAddInclusionBtn.addEventListener('click', () => {
  pkgInclusions.push('');
  renderPkgInclusionsList();
  renderActivationChecklist();
  pkgInclusionsListEl.querySelector(`[data-inclusion-index="${pkgInclusions.length - 1}"]`)?.focus();
});

pkgInclusionsListEl.addEventListener('input', (e) => {
  const input = e.target.closest('[data-inclusion-index]');
  if (!input) return;
  pkgInclusions[Number(input.dataset.inclusionIndex)] = input.value;
  renderActivationChecklist();
});

pkgInclusionsListEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-inclusion-action]');
  if (!btn) return;
  const index = Number(btn.closest('[data-index]').dataset.index);
  const action = btn.dataset.inclusionAction;
  if (action === 'remove') pkgInclusions.splice(index, 1);
  if (action === 'up' && index > 0) [pkgInclusions[index - 1], pkgInclusions[index]] = [pkgInclusions[index], pkgInclusions[index - 1]];
  if (action === 'down' && index < pkgInclusions.length - 1) [pkgInclusions[index + 1], pkgInclusions[index]] = [pkgInclusions[index], pkgInclusions[index + 1]];
  renderPkgInclusionsList();
  renderActivationChecklist();
});

// ═══════════════════════════════════════════════════════════════════════════════
// PACKAGE: VENUES (mapping, in-modal state)
// ═══════════════════════════════════════════════════════════════════════════════
function computeEffectiveMaxGuests(pkg, venue) {
  const pkgMax = Number(pkg?.max_guests ?? pkg?.guest_capacity ?? Infinity);
  const venueCap = Number(venue?.capacity ?? Infinity);
  return Math.min(pkgMax, venueCap);
}

function renderPkgVenuesList() {
  const minGuests = Number(pkgMinGuests.value) || 0;
  const activeVenues = allVenues.filter(v => v.is_active);

  if (!activeVenues.length) {
    pkgVenuesList.innerHTML = '<p class="modal-hint">No active venues yet — add one from the Venues screen first.</p>';
    return;
  }

  pkgVenuesList.innerHTML = activeVenues.map(v => {
    const checked = pkgVenueIds.has(v.venue_id);
    const belowMin = minGuests > 0 && v.capacity < minGuests;
    return `
      <label class="venue-option-row ${belowMin ? 'capacity-warn' : ''}">
        <input type="checkbox" data-venue-id="${v.venue_id}" ${checked ? 'checked' : ''} ${belowMin ? 'disabled' : ''}>
        <span>${escapeHtml(v.name)}</span>
        <span class="venue-option-cap">${belowMin ? `Holds ${v.capacity} — below the ${minGuests} minimum` : `${v.capacity} pax`}</span>
      </label>
    `;
  }).join('');
}

pkgVenuesList.addEventListener('change', (e) => {
  const cb = e.target.closest('[data-venue-id]');
  if (!cb) return;
  if (cb.checked) pkgVenueIds.add(cb.dataset.venueId);
  else pkgVenueIds.delete(cb.dataset.venueId);
  updateVenueCapacityHint();
  renderActivationChecklist();
  updateUnsavedBanner();
});

function updateVenueCapacityHint() {
  const maxGuests = Number(pkgMaxGuests.value) || null;
  if (!maxGuests || !pkgVenueIds.size) { pkgVenueCapacityHint.textContent = ''; return; }
  const warnings = [];
  pkgVenueIds.forEach(id => {
    const v = allVenues.find(x => x.venue_id === id);
    if (v && maxGuests > v.capacity) {
      warnings.push(`${v.name} holds ${v.capacity}, below this package's ${maxGuests} max — effective max there will be ${computeEffectiveMaxGuests({ max_guests: maxGuests }, v)}.`);
    }
  });
  pkgVenueCapacityHint.textContent = warnings.join(' ');
}

function updatePkgLocationVisibility() {
  const isAddon = pkgType.value === 'add on';
  const loc = pkgLocationType.value;
  const isOnsite = loc === 'onsite' || loc === 'both';

  pkgVenuesField.style.display = (!isAddon && isOnsite) ? '' : 'none';
  if (!isOnsite) pkgVenueIds.clear();
  if (isOnsite) renderPkgVenuesList();

  pkgLocationField.style.display = isAddon ? 'none' : '';
  pkgBookingScopeField.style.display = isAddon ? 'none' : '';
  pkgMaxQuantityField.style.display = isAddon ? '' : 'none';
  pkgCategoryHint.textContent = isAddon
    ? 'Packages must have a category. Add-ons may leave this unset.'
    : 'Required for packages.';
}

let pkgLocationPrevValue = '';
pkgLocationType.addEventListener('change', () => {
  const wasOnsite = pkgLocationPrevValue === 'onsite' || pkgLocationPrevValue === 'both';
  const nowOnsite = pkgLocationType.value === 'onsite' || pkgLocationType.value === 'both';
  if (wasOnsite && !nowOnsite && pkgVenueIds.size > 0) {
    const proceed = window.confirm(`Switching to offsite will remove ${pkgVenueIds.size} venue mapping(s) for this package. Continue?`);
    if (!proceed) { pkgLocationType.value = pkgLocationPrevValue; return; }
    pkgVenueIds.clear();
  }
  pkgLocationPrevValue = pkgLocationType.value;
  updatePkgLocationVisibility();
  renderActivationChecklist();
});

pkgType.addEventListener('change', () => { updatePkgLocationVisibility(); renderActivationChecklist(); });
pkgMinGuests.addEventListener('input', renderPkgVenuesList);
pkgMaxGuests.addEventListener('input', () => {
  if (Number(pkgMinGuests.value) > Number(pkgMaxGuests.value) && pkgMaxGuests.value !== '') {
    pkgGuestRangeHint.textContent = 'Min guests must be less than or equal to max guests.';
    pkgGuestRangeHint.style.color = '#b91c1c';
  } else {
    pkgGuestRangeHint.textContent = '';
  }
  updateVenueCapacityHint();
});

// ═══════════════════════════════════════════════════════════════════════════════
// PACKAGE: INLINE FIELD VALIDATION (blur)
// ═══════════════════════════════════════════════════════════════════════════════
function setFieldError(inputEl, errorEl, message) {
  if (message) {
    inputEl.classList.add('invalid');
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
  } else {
    inputEl.classList.remove('invalid');
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
  }
}

function clearFieldErrors() {
  setFieldError(pkgName, pkgNameError, '');
  setFieldError(pkgPrice, pkgPriceError, '');
  setFieldError(pkgDuration, pkgDurationError, '');
  setFieldError(pkgMaxGuests, pkgMaxGuestsError, '');
  setFieldError(pkgCategorySelect, pkgCategoryError, '');
}

pkgName.addEventListener('blur', () => {
  setFieldError(pkgName, pkgNameError, pkgName.value.trim() ? '' : 'Package name is required.');
});
pkgPrice.addEventListener('blur', () => {
  const v = pkgPrice.value;
  setFieldError(pkgPrice, pkgPriceError, (v === '' || isNaN(Number(v)) || Number(v) < 0) ? 'A valid price is required.' : '');
});
pkgDuration.addEventListener('blur', () => {
  const v = pkgDuration.value;
  setFieldError(pkgDuration, pkgDurationError, (!v || isNaN(parseInt(v, 10)) || parseInt(v, 10) < 1) ? 'A valid duration in hours is required.' : '');
});
pkgMaxGuests.addEventListener('blur', () => {
  const v = pkgMaxGuests.value;
  setFieldError(pkgMaxGuests, pkgMaxGuestsError, (v === '' || isNaN(parseInt(v, 10)) || parseInt(v, 10) < 1) ? 'A valid max guest count is required.' : '');
});
pkgCategorySelect.addEventListener('blur', () => {
  const needsCategory = pkgType.value === 'main';
  setFieldError(pkgCategorySelect, pkgCategoryError, (needsCategory && !pkgCategorySelect.value) ? 'Packages must have a category.' : '');
});

// ═══════════════════════════════════════════════════════════════════════════════
// PACKAGE: UNSAVED-CHANGES GUARD
// ═══════════════════════════════════════════════════════════════════════════════
function getPkgFormState() {
  return JSON.stringify({
    name: pkgName.value, type: pkgType.value, category: pkgCategorySelect.value,
    description: pkgDescription.value, price: pkgPrice.value, duration: pkgDuration.value,
    maxQty: pkgMaxQuantity.value, minGuests: pkgMinGuests.value, maxGuests: pkgMaxGuests.value,
    extPrice: pkgExtensionPrice.value, location: pkgLocationType.value, bookingScope: pkgBookingScope.value,
    active: pkgActiveToggle.checked,
    usesCateringMenu: pkgUsesCateringMenuToggle.checked,
    inclusions: pkgInclusions,
    venues: Array.from(pkgVenueIds).sort(),
    photos: pkgPhotos.map(p => ({ id: p.photo_id || null, url: p.image_url || null, alt: p.alt_text, cover: p.is_cover })),
  });
}

function snapshotPkgForm() {
  pkgFormSnapshot = getPkgFormState();
  pkgUnsavedBanner.classList.add('hidden');
}

function isPkgFormDirty() {
  if (pkgFormSnapshot === null) return false;
  return getPkgFormState() !== pkgFormSnapshot;
}

function updateUnsavedBanner() {
  pkgUnsavedBanner.classList.toggle('hidden', !isPkgFormDirty());
}

function attemptClosePackageModal() {
  if (isPkgFormDirty()) {
    pendingAction = { scope: 'discard-package-changes' };
    confirmTitle.textContent = 'Discard Unsaved Changes?';
    confirmCopy.textContent  = 'You have unsaved changes to this package. Closing now will discard them.';
    confirmOk.textContent    = 'Discard Changes';
    confirmOk.className      = 'btn-danger';
    setModalMsg(confirmMessage, '');
    openModal(confirmModal);
    return;
  }
  pkgFormSnapshot = null;
  closeModal(packageModal);
}

packageModal.querySelector('.modal-body').addEventListener('input', updateUnsavedBanner);
packageModal.querySelector('.modal-body').addEventListener('change', updateUnsavedBanner);

// ═══════════════════════════════════════════════════════════════════════════════
// PACKAGE: ACTIVATION CHECKLIST
// ═══════════════════════════════════════════════════════════════════════════════
function getActivationBlockers() {
  const blockers = [];
  if (!pkgPhotos.length) blockers.push('At least one photo');
  if (pkgPhotos.some(p => !p.alt_text || !p.alt_text.trim())) blockers.push('Alt text on every photo');
  if (!pkgInclusions.some(i => i.trim())) blockers.push('At least one inclusion');
  const isAddon = pkgType.value === 'add on';
  const isOnsite = pkgLocationType.value === 'onsite' || pkgLocationType.value === 'both';
  if (!isAddon && isOnsite && pkgVenueIds.size === 0) blockers.push('At least one venue mapping (onsite package)');
  if (!isAddon && (!pkgPrice.value || Number(pkgPrice.value) <= 0)) blockers.push('A price greater than ₱0');
  return blockers;
}

function renderActivationChecklist() {
  const blockers = getActivationBlockers();
  const items = [
    { label: 'At least one photo', met: pkgPhotos.length > 0 },
    { label: 'Alt text on every photo', met: pkgPhotos.length > 0 && pkgPhotos.every(p => p.alt_text && p.alt_text.trim()) },
    { label: 'At least one inclusion', met: pkgInclusions.some(i => i.trim()) },
  ];
  const isAddon = pkgType.value === 'add on';
  const isOnsite = pkgLocationType.value === 'onsite' || pkgLocationType.value === 'both';
  if (!isAddon && isOnsite) items.push({ label: 'At least one venue mapping', met: pkgVenueIds.size > 0 });
  if (!isAddon) items.push({ label: 'Price greater than ₱0', met: Number(pkgPrice.value) > 0 });

  pkgActivationChecklist.innerHTML = items.map(item => `
    <div class="checklist-item ${item.met ? 'met' : 'unmet'}">${item.met ? '✓' : '○'} ${escapeHtml(item.label)}</div>
  `).join('');

  if (blockers.length && pkgActiveToggle.checked) {
    pkgActiveToggle.checked = false;
  }
  pkgActiveToggle.disabled = blockers.length > 0;
}

[pkgPrice, pkgType, pkgLocationType, pkgMinGuests, pkgMaxGuests].forEach(el => {
  el.addEventListener('input', renderActivationChecklist);
  el.addEventListener('change', renderActivationChecklist);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PACKAGE: MODAL (Add / Edit)
// ═══════════════════════════════════════════════════════════════════════════════
function populateCategorySelect(preselectId) {
  pkgCategorySelect.innerHTML =
    '<option value="">No category (add-ons only)</option>' +
    allCategories.filter(c => c.is_active).map(c =>
      `<option value="${c.package_category_id}">${escapeHtml(c.category_name)}</option>`
    ).join('');
  pkgCategorySelect.value = preselectId || '';
}

function openAddPackageModal() {
  editingPackageId   = null;
  pkgModalTitle.textContent     = 'Add New Package';
  pkgModalSub.textContent       = 'Create a new event package with details, pricing, and image';
  pkgModalSaveLabel.textContent = 'Add Package';
  clearPackageForm();
  const preselect = (selectedRailCategoryId && selectedRailCategoryId !== 'uncategorised') ? selectedRailCategoryId : '';
  populateCategorySelect(preselect);
  pkgLocationPrevValue = '';
  updatePkgLocationVisibility();
  renderActivationChecklist();
  setModalMsg(pkgModalMessage, '');
  openModal(packageModal);
  snapshotPkgForm();
}

async function openEditPackageModal(packageId) {
  const pkg = allPackages.find(p => p.package_id === packageId);
  if (!pkg) return;

  editingPackageId    = packageId;
  pkgModalTitle.textContent     = 'Edit Package';
  pkgModalSub.textContent       = 'Update the package details below';
  pkgModalSaveLabel.textContent = 'Save Changes';
  clearFieldErrors();

  pkgName.value           = pkg.package_name || '';
  pkgType.value           = pkg.package_type || '';
  pkgDescription.value    = pkg.description || '';
  pkgPrice.value          = pkg.price ?? '';
  pkgMinGuests.value      = pkg.min_guests ?? '';
  pkgMaxGuests.value      = pkg.max_guests ?? pkg.guest_capacity ?? '';
  pkgMaxQuantity.value    = pkg.max_quantity ?? 1;
  pkgDuration.value       = pkg.duration_hours ?? '';
  pkgExtensionPrice.value = pkg.extension_price ?? '';
  pkgLocationType.value   = pkg.location_type || '';
  pkgLocationPrevValue    = pkg.location_type || '';
  pkgBookingScope.value   = pkg.booking_scope || '';
  pkgActiveToggle.checked = !!pkg.is_active;
  pkgUsesCateringMenuToggle.checked = !!pkg.uses_catering_menu;

  populateCategorySelect(pkg.package_category_id);

  pkgInclusions = Array.isArray(pkg.inclusions) && pkg.inclusions.length
    ? [...pkg.inclusions]
    : [];
  renderPkgInclusionsList();

  setModalMsg(pkgModalMessage, 'Loading photos and venues…', 'success');
  openModal(packageModal);

  try {
    const [{ data: photos }, { data: venueRows }] = await Promise.all([
      supabase.from(PACKAGE_PHOTO_TABLE).select('*').eq('package_id', packageId).order('sort_order', { ascending: true }),
      supabase.from(PACKAGE_VENUE_TABLE).select('venue_id').eq('package_id', packageId)
    ]);
    pkgPhotos = (photos || []).map(p => ({ ...p }));
    pkgVenueIds = new Set((venueRows || []).map(r => r.venue_id));
  } catch (err) {
    setModalMsg(pkgModalMessage, `Failed to load photos/venues: ${err.message}`);
  }

  renderPkgPhotosGrid();
  updatePkgLocationVisibility();
  renderActivationChecklist();
  setModalMsg(pkgModalMessage, '');
  snapshotPkgForm();
}

function clearPackageForm() {
  [pkgName, pkgDescription, pkgPrice, pkgDuration, pkgExtensionPrice, pkgMinGuests, pkgMaxGuests].forEach(el => el.value = '');
  pkgType.value         = '';
  pkgLocationType.value = '';
  pkgBookingScope.value = '';
  pkgMaxQuantity.value  = '1';
  pkgActiveToggle.checked = false;
  pkgUsesCateringMenuToggle.checked = false;
  pkgPhotos      = [];
  pkgInclusions  = [];
  pkgVenueIds    = new Set();
  clearFieldErrors();
  renderPkgPhotosGrid();
  renderPkgInclusionsList();
}

// Package validation
function validatePackageForm() {
  if (!pkgName.value.trim()) return 'Package name is required.';
  if (!pkgType.value)        return 'Package type is required.';
  if (pkgType.value === 'main' && !pkgCategorySelect.value) return 'Packages must have a category.';
  if (pkgPrice.value === '' || isNaN(Number(pkgPrice.value)) || Number(pkgPrice.value) < 0)
    return 'A valid price is required.';
  if (pkgMaxGuests.value === '' || isNaN(parseInt(pkgMaxGuests.value, 10)) || parseInt(pkgMaxGuests.value, 10) < 1)
    return 'A valid max guest count is required.';
  if (pkgMinGuests.value !== '' && Number(pkgMinGuests.value) > Number(pkgMaxGuests.value))
    return 'Min guests must be less than or equal to max guests.';
  if (!pkgDuration.value || isNaN(parseInt(pkgDuration.value)) || parseInt(pkgDuration.value) < 1)
    return 'A valid duration in hours is required.';
  if (pkgType.value === 'main' && !pkgBookingScope.value)
    return 'Booking Scope is required for Main packages — it determines which reservations block each other on the calendar.';
  if (pkgType.value === 'main') {
    const isOnsite = pkgLocationType.value === 'onsite' || pkgLocationType.value === 'both';
    // Bug fix: this used to block save unconditionally, even though the
    // message itself says draft saves are allowed — pkgActiveToggle was
    // never actually checked. Only require a venue when the package is
    // being saved active; an inactive/draft package can be saved without
    // one and have its venue added later.
    if (isOnsite && pkgVenueIds.size === 0 && pkgActiveToggle.checked) {
      return 'Onsite packages need at least one venue mapping to activate. Turn off "Active" to save as a draft without one.';
    }
  }
  return null;
}

// Package save
pkgModalSave.addEventListener('click', async () => {
  const err = validatePackageForm();
  if (err) { setModalMsg(pkgModalMessage, err); return; }

  pkgModalSave.disabled = true;
  pkgModalSaveLabel.textContent = 'Saving…';
  setModalMsg(pkgModalMessage, '');

  try {
    const maxGuests = parseInt(pkgMaxGuests.value, 10);
    const cleanInclusions = pkgInclusions.map(i => i.trim()).filter(Boolean);

    const payload = {
      package_name:       pkgName.value.trim(),
      package_type:       pkgType.value,
      description:        pkgDescription.value.trim() || null,
      price:              Number(pkgPrice.value),
      guest_capacity:     maxGuests, // kept in sync with max_guests for existing consumers
      min_guests:         pkgMinGuests.value !== '' ? Number(pkgMinGuests.value) : null,
      max_guests:         maxGuests,
      max_quantity:       pkgType.value === 'add on' ? (parseInt(pkgMaxQuantity.value, 10) || 1) : 1,
      inclusions:         cleanInclusions,
      duration_hours:     parseInt(pkgDuration.value, 10),
      extension_price:    pkgExtensionPrice.value !== '' ? Number(pkgExtensionPrice.value) : null,
      location_type:      pkgLocationType.value || null,
      booking_scope:      pkgBookingScope.value || null,
      package_category_id: pkgCategorySelect.value || null,
      is_active:          !!pkgActiveToggle.checked,
      uses_catering_menu: !!pkgUsesCateringMenuToggle.checked,
    };

    let packageId = editingPackageId;

    if (editingPackageId) {
      const { data, error } = await supabase
        .from('package')
        .update(payload)
        .eq('package_id', editingPackageId)
        .select()
        .single();
      if (error) throw error;
      const idx = allPackages.findIndex(p => p.package_id === editingPackageId);
      if (idx !== -1) allPackages[idx] = data;
      await logAudit({
        action:   'Updated Package',
        category: 'package',
        details:  `Package updated: ${payload.package_name}`,
        entityId: editingPackageId
      });
      setMessage(inventoryPageMessage, 'Package updated successfully.', 'success');
    } else {
      const { data, error } = await supabase
        .from('package')
        .insert(payload)
        .select()
        .single();
      if (error) throw error;
      packageId = data.package_id;
      allPackages.unshift(data);
      await logAudit({
        action:   'Added Package',
        category: 'package',
        details:  `New package created: ${payload.package_name}`,
        entityId: data.package_id
      });
      setMessage(inventoryPageMessage, 'Package added successfully.', 'success');
    }

    // Photos: upload any pending files, then replace the photo rows for
    // this package (simplest correct approach — small galleries, max 8).
    setModalMsg(pkgModalMessage, 'Saving photos…', 'success');
    for (const photo of pkgPhotos) {
      if (photo.file && !photo.image_url) {
        photo.image_url = await uploadToCloudinary(photo.file);
      }
    }
    const { data: existingPhotos } = await supabase.from(PACKAGE_PHOTO_TABLE).select('photo_id, image_url').eq('package_id', packageId);
    const keptIds = new Set(pkgPhotos.filter(p => p.photo_id).map(p => p.photo_id));
    for (const old of (existingPhotos || [])) {
      if (!keptIds.has(old.photo_id)) {
        await supabase.from(PACKAGE_PHOTO_TABLE).delete().eq('photo_id', old.photo_id);
        await destroyCloudinaryImage(supabase, old.image_url);
      }
    }
    for (let i = 0; i < pkgPhotos.length; i++) {
      const photo = pkgPhotos[i];
      const row = { package_id: packageId, image_url: photo.image_url, alt_text: photo.alt_text || null, is_cover: !!photo.is_cover, sort_order: i };
      if (photo.photo_id) {
        await supabase.from(PACKAGE_PHOTO_TABLE).update(row).eq('photo_id', photo.photo_id);
      } else {
        const { data: inserted } = await supabase.from(PACKAGE_PHOTO_TABLE).insert(row).select('photo_id').single();
        if (inserted) photo.photo_id = inserted.photo_id;
      }
    }
    const coverPhoto = pkgPhotos.find(p => p.is_cover);
    const savedIdx = allPackages.findIndex(p => p.package_id === packageId);
    if (savedIdx !== -1) allPackages[savedIdx]._coverImage = coverPhoto ? coverPhoto.image_url : null;

    // Venue mappings: capacity-validate, then replace the set for this package.
    setModalMsg(pkgModalMessage, 'Saving venue mappings…', 'success');
    const minGuests = pkgMinGuests.value !== '' ? Number(pkgMinGuests.value) : null;
    for (const venueId of pkgVenueIds) {
      const venue = allVenues.find(v => v.venue_id === venueId);
      if (venue && minGuests && venue.capacity < minGuests) {
        throw new Error(`${venue.name} holds ${venue.capacity} guests. ${payload.package_name} requires at least ${minGuests}.`);
      }
    }
    await supabase.from(PACKAGE_VENUE_TABLE).delete().eq('package_id', packageId);
    if (pkgVenueIds.size) {
      await supabase.from(PACKAGE_VENUE_TABLE).insert(
        Array.from(pkgVenueIds).map(venue_id => ({ package_id: packageId, venue_id }))
      );
    }
    allPackageVenueCounts.set(packageId, pkgVenueIds.size);

    pkgFormSnapshot = null;
    renderCategoryRail();
    renderInventory();
    closeModal(packageModal);

  } catch (err) {
    setModalMsg(pkgModalMessage, `Failed to save: ${err.message}`);
  } finally {
    pkgModalSave.disabled = false;
    pkgModalSaveLabel.textContent = editingPackageId ? 'Save Changes' : 'Add Package';
  }
});

addPackageBtn.addEventListener('click', openAddPackageModal);
pkgModalClose.addEventListener('click',  attemptClosePackageModal);
pkgModalCancel.addEventListener('click', attemptClosePackageModal);
packageModal.addEventListener('click', e => { if (e.target === packageModal) attemptClosePackageModal(); });

// ═══════════════════════════════════════════════════════════════════════════════
// PACKAGE: ARCHIVE / RESTORE / DELETE
// ═══════════════════════════════════════════════════════════════════════════════
function openConfirmArchivePackage(packageId) {
  const pkg = allPackages.find(p => p.package_id === packageId);
  if (!pkg) return;
  pendingAction = { scope: 'package', type: 'archive', id: packageId };
  confirmTitle.textContent = 'Archive Package';
  confirmCopy.textContent  = `Are you sure you want to archive "${pkg.package_name}"? It will no longer be visible to customers.`;
  confirmOk.textContent    = 'Archive';
  confirmOk.className      = 'btn-danger';
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

function openConfirmRestorePackage(packageId) {
  const pkg = allPackages.find(p => p.package_id === packageId);
  if (!pkg) return;
  pendingAction = { scope: 'package', type: 'restore', id: packageId };
  confirmTitle.textContent = 'Restore Package';
  confirmCopy.textContent  = `Restore "${pkg.package_name}" and make it visible to customers again?`;
  confirmOk.textContent    = 'Restore';
  confirmOk.className      = 'btn-primary';
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

// Package delete: zero reservations → real delete (+ Cloudinary cleanup).
// One or more → offer archive instead, naming the count.
async function openConfirmDeletePackage(packageId) {
  const pkg = allPackages.find(p => p.package_id === packageId);
  if (!pkg) return;

  setMessage(inventoryPageMessage, 'Checking reservations…');
  let count;
  try {
    count = await countPackageReservationRefs(packageId);
  } catch (err) {
    setMessage(inventoryPageMessage, `Failed to check reservations: ${err.message}`, 'error');
    return;
  }
  setMessage(inventoryPageMessage, '');

  deleteReassignField.classList.add('hidden');

  if (count > 0) {
    pendingDeleteAction = { scope: 'package', id: packageId, mode: 'archive' };
    deleteModalTitle.textContent = 'Archive Instead';
    deleteModalCopy.textContent  = `${count} reservation${count === 1 ? '' : 's'} use "${pkg.package_name}". Archive it instead — it stays on those bookings but is hidden from customers.`;
    deleteModalOk.textContent    = 'Archive';
  } else {
    pendingDeleteAction = { scope: 'package', id: packageId, mode: 'delete' };
    deleteModalTitle.textContent = 'Delete Package';
    deleteModalCopy.textContent  = `Delete "${pkg.package_name}"? This removes its photos and venue mappings too. This can't be undone.`;
    deleteModalOk.textContent    = 'Delete';
  }
  deleteModalOk.disabled = false;
  setModalMsg(deleteModalMessage, '');
  openModal(deleteModal);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED DELETE MODAL HANDLER (category / package / venue)
// ═══════════════════════════════════════════════════════════════════════════════
deleteModalOk.addEventListener('click', async () => {
  if (!pendingDeleteAction) return;
  const { scope, id, mode } = pendingDeleteAction;
  deleteModalOk.disabled = true;

  try {
    if (scope === 'category') {
      if (!deleteReassignField.classList.contains('hidden') && deleteReassignSelect.value) {
        const { error: reErr } = await supabase.from('package').update({ package_category_id: deleteReassignSelect.value }).eq('package_category_id', id);
        if (reErr) throw reErr;
        allPackages.forEach(p => { if (p.package_category_id === id) p.package_category_id = deleteReassignSelect.value; });
      }
      const cat = allCategories.find(c => c.package_category_id === id);
      const { error } = await supabase.from(CATEGORY_TABLE).delete().eq('package_category_id', id);
      if (error) throw error;
      allCategories = allCategories.filter(c => c.package_category_id !== id);
      await logAudit({ action: 'Deleted Category', category: 'package', details: `Deleted category: ${cat?.category_name}`, entityId: id });
      renderCategoryRail();
      renderInventory();
      setMessage(inventoryPageMessage, 'Category deleted.', 'success');

    } else if (scope === 'package') {
      const pkg = allPackages.find(p => p.package_id === id);
      if (mode === 'archive') {
        const { error } = await supabase.from('package').update({ is_active: false }).eq('package_id', id);
        if (error) throw error;
        const idx = allPackages.findIndex(p => p.package_id === id);
        if (idx !== -1) allPackages[idx] = { ...allPackages[idx], is_active: false };
        await logAudit({ action: 'Archived Package', category: 'package', details: `Archived (has reservations): ${pkg?.package_name}`, entityId: id });
        setMessage(inventoryPageMessage, 'Package archived.', 'success');
      } else {
        const { data: photos } = await supabase.from(PACKAGE_PHOTO_TABLE).select('image_url').eq('package_id', id);
        for (const photo of (photos || [])) { await destroyCloudinaryImage(supabase, photo.image_url); }
        if (pkg?.package_image) await destroyCloudinaryImage(supabase, pkg.package_image);
        const { error } = await supabase.from('package').delete().eq('package_id', id);
        if (error) throw error;
        await logAudit({ action: 'Deleted Package', category: 'package', details: `Deleted package: ${pkg?.package_name}`, entityId: id });
        setMessage(inventoryPageMessage, 'Package deleted.', 'success');
      }
      allPackages = allPackages.filter(p => p.package_id !== id || mode === 'archive');
      renderCategoryRail();
      renderInventory();

    } else if (scope === 'venue') {
      const venue = allVenues.find(v => v.venue_id === id);
      const { error } = await supabase.from(VENUE_TABLE).delete().eq('venue_id', id);
      if (error) throw error;
      allVenues = allVenues.filter(v => v.venue_id !== id);
      await logAudit({ action: 'Deleted Venue', category: 'package', details: `Deleted venue: ${venue?.name}`, entityId: id });
      renderVenueTables();
      setMessage(venuePageMessage, 'Venue deleted.', 'success');

    } else if (scope === 'badge-type') {
      const badge = allBadgeDefs.find(b => b.badge_id === id);
      if (mode === 'archive') {
        const { error } = await supabase.from(BADGE_TABLE).update({ is_active: false }).eq('badge_id', id);
        if (error) throw error;
        const idx = allBadgeDefs.findIndex(b => b.badge_id === id);
        if (idx !== -1) allBadgeDefs[idx] = { ...allBadgeDefs[idx], is_active: false };
        await logAudit({ action: 'Archived Badge Type', category: 'package', details: `Archived (in use): ${badge?.label}`, entityId: id });
        setMessage(badgeTypesPageMessage, 'Badge type archived.', 'success');
      } else {
        const { error } = await supabase.from(BADGE_TABLE).delete().eq('badge_id', id);
        if (error) throw error;
        allBadgeDefs = allBadgeDefs.filter(b => b.badge_id !== id);
        await logAudit({ action: 'Deleted Badge Type', category: 'package', details: `Deleted badge type: ${badge?.label}`, entityId: id });
        setMessage(badgeTypesPageMessage, 'Badge type deleted.', 'success');
      }
      renderBadgeTypesTables();
      renderInventory();

    } else if (scope === 'catering-category') {
      const cat = allCateringCategories.find(c => c.category_id === id);
      // catering_dish rows cascade automatically (ON DELETE CASCADE, see
      // 20260820_catering_menu.sql) — no separate dish cleanup needed here.
      const { error } = await supabase.from(CATERING_CATEGORY_TABLE).delete().eq('category_id', id);
      if (error) throw error;
      allCateringCategories = allCateringCategories.filter(c => c.category_id !== id);
      allCateringDishes = allCateringDishes.filter(d => d.category_id !== id);
      await logAudit({ action: 'Deleted Catering Category', category: 'package', details: `Deleted catering category: ${cat?.name}`, entityId: id });
      renderCateringTables();
      setMessage(cateringPageMessage, 'Category deleted.', 'success');
    }

    closeModal(deleteModal);
  } catch (err) {
    setModalMsg(deleteModalMessage, `Failed: ${err.message}`);
  } finally {
    deleteModalOk.disabled = false;
    pendingDeleteAction = null;
  }
});

deleteModalClose.addEventListener('click',  () => closeModal(deleteModal));
deleteModalCancel.addEventListener('click', () => closeModal(deleteModal));
deleteModal.addEventListener('click', e => { if (e.target === deleteModal) closeModal(deleteModal); });

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIRM MODAL: Shared handler (archive/restore for category, package, tier, venue)
// ═══════════════════════════════════════════════════════════════════════════════
confirmOk.addEventListener('click', async () => {
  if (!pendingAction) return;
  const { scope, type, id, payload } = pendingAction;
  confirmOk.disabled = true;

  try {
    const isActive = type === 'restore';

    if (scope === 'discard-package-changes') {
      pkgFormSnapshot = null;
      closeModal(packageModal);
    }

    if (scope === 'discard-category-changes') {
      catFormSnapshot = null;
      closeModal(categoryModal);
    }

    if (scope === 'category') {
      const cat = allCategories.find(c => c.package_category_id === id);
      const { error, count } = await supabase
        .from(CATEGORY_TABLE)
        .update({ is_active: isActive }, { count: 'exact' })
        .eq('package_category_id', id);
      if (error) throw error;
      if (count === 0) throw new Error('No rows updated — check database permissions.');
      const idx = allCategories.findIndex(c => c.package_category_id === id);
      if (idx !== -1) allCategories[idx] = { ...allCategories[idx], is_active: isActive };
      await logAudit({
        action:   type === 'archive' ? 'Archived Category' : 'Restored Category',
        category: 'package',
        details:  `Category ${type === 'archive' ? 'archived' : 'restored'}: ${cat?.category_name}`,
        entityId: id
      });
      renderCategoryRail();
      renderInventory();
      setMessage(inventoryPageMessage, type === 'archive' ? 'Category archived.' : 'Category restored.', 'success');
    }

    if (scope === 'package') {
      const pkg = allPackages.find(p => p.package_id === id);
      const { error, count } = await supabase
        .from('package')
        .update({ is_active: isActive }, { count: 'exact' })
        .eq('package_id', id);
      if (error) throw error;
      if (count === 0) throw new Error('No rows updated — check database permissions.');
      const idx = allPackages.findIndex(p => p.package_id === id);
      if (idx !== -1) allPackages[idx] = { ...allPackages[idx], is_active: isActive };
      const catName = allCategories.find(c => c.package_category_id === pkg?.package_category_id)?.category_name || 'Uncategorised';
      await logAudit({
        action:   type === 'archive' ? 'Archived Package' : 'Restored Package',
        category: 'package',
        details:  `Package ${type === 'archive' ? 'archived' : 'restored'}: ${pkg?.package_name} (Category: ${catName})`,
        entityId: id
      });
      selectedStatus = isActive ? 'active' : 'archived';
      syncStatusSegUI();
      renderCategoryRail();
      renderInventory();
      setMessage(inventoryPageMessage, type === 'archive' ? 'Package archived.' : 'Package restored.', 'success');
    }

    if (scope === 'tier') {
      const tier = allTiers.find(t => t.tier_id === id);
      const { error, count } = await supabase
        .from(TIER_TABLE)
        .update({ is_active: isActive }, { count: 'exact' })
        .eq('tier_id', id);
      if (error) throw error;
      if (count === 0) throw new Error('No rows updated — check database permissions.');
      const idx = allTiers.findIndex(t => t.tier_id === id);
      if (idx !== -1) allTiers[idx] = { ...allTiers[idx], is_active: isActive };
      await logAudit({
        action:   type === 'archive' ? 'Archived Tier' : 'Restored Tier',
        category: 'package',
        details:  `Tier ${type === 'archive' ? 'archived' : 'restored'}: ${tier?.tier_name} (Package: ${tierForPackageName})`,
        entityId: id
      });
      renderTierTable();
      allTiersByPackage.set(tierForPackageId, allTiers.filter(t => t.is_active));
      renderInventory();
    }

    if (scope === 'venue') {
      const venue = allVenues.find(v => v.venue_id === id);
      const { error, count } = await supabase
        .from(VENUE_TABLE)
        .update({ is_active: isActive }, { count: 'exact' })
        .eq('venue_id', id);
      if (error) throw error;
      if (count === 0) throw new Error('No rows updated — check database permissions.');
      const idx = allVenues.findIndex(v => v.venue_id === id);
      if (idx !== -1) allVenues[idx] = { ...allVenues[idx], is_active: isActive };
      await logAudit({
        action:   type === 'archive' ? 'Archived Venue' : 'Restored Venue',
        category: 'package',
        details:  `Venue ${type === 'archive' ? 'archived' : 'restored'}: ${venue?.name}`,
        entityId: id
      });
      renderVenueTables();
      setMessage(venuePageMessage, type === 'archive' ? 'Venue archived.' : 'Venue restored.', 'success');
    }

    if (scope === 'badge-type') {
      const badge = allBadgeDefs.find(b => b.badge_id === id);
      const { error, count } = await supabase
        .from(BADGE_TABLE)
        .update({ is_active: isActive }, { count: 'exact' })
        .eq('badge_id', id);
      if (error) throw error;
      if (count === 0) throw new Error('No rows updated — check database permissions.');
      const idx = allBadgeDefs.findIndex(b => b.badge_id === id);
      if (idx !== -1) allBadgeDefs[idx] = { ...allBadgeDefs[idx], is_active: isActive };
      await logAudit({
        action:   type === 'archive' ? 'Archived Badge Type' : 'Restored Badge Type',
        category: 'package',
        details:  `Badge type ${type === 'archive' ? 'archived' : 'restored'}: ${badge?.label}`,
        entityId: id
      });
      renderBadgeTypesTables();
      renderInventory();
      setMessage(badgeTypesPageMessage, type === 'archive' ? 'Badge type archived.' : 'Badge type restored.', 'success');
    }

    if (scope === 'catering-category') {
      const cat = allCateringCategories.find(c => c.category_id === id);
      const { error, count } = await supabase
        .from(CATERING_CATEGORY_TABLE)
        .update({ is_active: isActive }, { count: 'exact' })
        .eq('category_id', id);
      if (error) throw error;
      if (count === 0) throw new Error('No rows updated — check database permissions.');
      const idx = allCateringCategories.findIndex(c => c.category_id === id);
      if (idx !== -1) allCateringCategories[idx] = { ...allCateringCategories[idx], is_active: isActive };
      await logAudit({
        action:   type === 'archive' ? 'Archived Catering Category' : 'Restored Catering Category',
        category: 'package',
        details:  `Catering category ${type === 'archive' ? 'archived' : 'restored'}: ${cat?.name}`,
        entityId: id
      });
      renderCateringTables();
      setMessage(cateringPageMessage, type === 'archive' ? 'Category archived.' : 'Category restored.', 'success');
    }

    if (scope === 'badge-move') {
      const { badgeId, conflictPackageId, badgeLabel, conflictPackageName } = payload;
      const { error: delErr } = await supabase.from(PACKAGE_BADGE_TABLE).delete()
        .eq('package_id', conflictPackageId).eq('badge_id', badgeId);
      if (delErr) throw delErr;
      const { error: insErr } = await supabase.from(PACKAGE_BADGE_TABLE).insert({ package_id: id, badge_id: badgeId });
      if (insErr) throw insErr;

      const pkg = allPackages.find(p => p.package_id === id);
      await logAudit({
        action: 'Reassigned Badge',
        category: 'package',
        details: `Moved "${badgeLabel}" from "${conflictPackageName}" to "${pkg?.package_name}"`,
        entityId: id
      });

      // The moved-from package no longer holds this badge — drop it from the
      // in-memory map so its card stops showing the chip without a reload.
      for (const [pkgId, badgeSet] of packageBadgeMap.entries()) {
        if (pkgId !== id) badgeSet.delete(badgeId);
      }
      if (!packageBadgeMap.has(id)) packageBadgeMap.set(id, new Set());
      packageBadgeMap.get(id).add(badgeId);

      renderInventory();
      if (badgeModalPackageId === id && pkg) renderBadgeModal(pkg);
      setMessage(inventoryPageMessage, 'Badge moved.', 'success');
    }

    closeModal(confirmModal);
  } catch (err) {
    setModalMsg(confirmMessage, `Failed: ${err.message}`);
  } finally {
    confirmOk.disabled = false;
    pendingAction = null;
  }
});

confirmClose.addEventListener('click',  () => closeModal(confirmModal));
confirmCancel.addEventListener('click', () => closeModal(confirmModal));
confirmModal.addEventListener('click', e => { if (e.target === confirmModal) closeModal(confirmModal); });

// ═══════════════════════════════════════════════════════════════════════════════
// BADGES (Best Value / Best Seller / promo labels)
// ═══════════════════════════════════════════════════════════════════════════════
function openBadgeModal(packageId) {
  const pkg = allPackages.find(p => p.package_id === packageId);
  if (!pkg) return;
  badgeModalPackageId = packageId;
  setModalMsg(badgeModalMessage, '');
  renderBadgeModal(pkg);
  openModal(badgeModal);
}

function renderBadgeModal(pkg) {
  const bsDef = allBadgeDefs.find(b => b.badge_key === 'best_seller');
  if (bsDef && bsDef.is_assignable) {
    // Manual mode — Best Seller behaves like any other badge (it's already
    // included in the chip list below); this row is just the mode switch.
    badgeBestSellerRow.innerHTML = `
      <div class="badge-mode-row">
        <span>Best Seller is set manually — choose it below like any other badge.</span>
        <button type="button" class="badge-mode-toggle" data-toggle-bestseller>Switch to automatic</button>
      </div>`;
  } else if (bsDef) {
    const isBestSeller = bestSellerByCategory.get(pkg.package_category_id) === pkg.package_id;
    badgeBestSellerRow.innerHTML = `
      <div class="badge-readonly-row ${isBestSeller ? 'is-active' : ''}">
        <span>
          <span>${escapeHtml(bsDef.label)}</span><br>
          <span style="font-size:11px;opacity:.85">${isBestSeller ? 'Automatically set — most booked in this category' : 'Not automatic yet — based on non-cancelled bookings'}</span>
        </span>
        <button type="button" class="badge-mode-toggle" data-toggle-bestseller>Switch to manual</button>
      </div>`;
  } else {
    badgeBestSellerRow.innerHTML = '';
  }

  const assignedIds = packageBadgeMap.get(pkg.package_id) || new Set();
  const assignable = allBadgeDefs.filter(b => b.is_assignable && b.is_active);
  badgeChipList.innerHTML = assignable.map(b => `
    <button type="button" class="badge-toggle-chip ${assignedIds.has(b.badge_id) ? 'active variant-' + escapeHtml(b.variant) : ''}"
            data-badge-id="${b.badge_id}">
      ${escapeHtml(b.label)}
    </button>`).join('');
}

// Global switch (not per-package): whether Best Seller is computed
// automatically from booking counts or hand-assigned like Best Value.
// Switching to automatic clears any manual assignments so they can't linger
// alongside — or conflict with — the derived winner.
async function toggleBestSellerMode() {
  const bs = allBadgeDefs.find(b => b.badge_key === 'best_seller');
  if (!bs) return;
  const goingManual = !bs.is_assignable;
  const confirmMsg = goingManual
    ? 'Switch Best Seller to manual? You will choose which package holds it per category, and it will stop updating automatically from bookings.'
    : 'Switch Best Seller to automatic? Any manually-assigned Best Seller badges will be cleared, and the most-booked package per category will be shown instead.';
  if (!window.confirm(confirmMsg)) return;

  try {
    const { error } = await supabase.from(BADGE_TABLE).update({ is_assignable: goingManual }).eq('badge_id', bs.badge_id);
    if (error) throw error;
    bs.is_assignable = goingManual;

    if (!goingManual) {
      const { error: delErr } = await supabase.from(PACKAGE_BADGE_TABLE).delete().eq('badge_id', bs.badge_id);
      if (delErr) throw delErr;
      packageBadgeMap.forEach(set => set.delete(bs.badge_id));
    }

    await logAudit({
      action: 'Changed Best Seller Mode',
      category: 'package',
      details: `Best Seller is now ${goingManual ? 'manually assigned' : 'automatic (most booked)'}`
    });

    const pkg = allPackages.find(p => p.package_id === badgeModalPackageId);
    if (pkg) renderBadgeModal(pkg);
    renderInventory();
  } catch (err) {
    setModalMsg(badgeModalMessage, `Failed: ${err.message}`);
  }
}

badgeBestSellerRow.addEventListener('click', (e) => {
  if (e.target.closest('[data-toggle-bestseller]')) toggleBestSellerMode();
});

badgeChipList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.badge-toggle-chip');
  if (!btn || !badgeModalPackageId) return;
  const badgeId = btn.dataset.badgeId;
  const pkg = allPackages.find(p => p.package_id === badgeModalPackageId);
  const def = allBadgeDefs.find(b => b.badge_id === badgeId);
  const isOn = btn.classList.contains('active');
  if (!pkg || !def) return;

  btn.disabled = true;
  try {
    if (isOn) {
      const { error } = await supabase.from(PACKAGE_BADGE_TABLE).delete()
        .eq('package_id', badgeModalPackageId).eq('badge_id', badgeId);
      if (error) throw error;
      packageBadgeMap.get(badgeModalPackageId)?.delete(badgeId);
      await logAudit({ action: 'Removed Badge', category: 'package', details: `Removed "${def.label}" from ${pkg.package_name}`, entityId: badgeModalPackageId });
    } else if (def.unique_scope === 'category') {
      // Pre-check for an existing holder in the same category so the admin
      // gets a "move it here?" prompt instead of a raw DB rejection — the
      // trigger in the migration is just the backstop if this is bypassed.
      // allPackages/packageBadgeMap are already fully loaded (loadInventory),
      // so this is a plain in-memory lookup, no extra round trip needed.
      const conflictPkg = allPackages.find(p =>
        p.package_id !== pkg.package_id &&
        p.package_category_id === pkg.package_category_id &&
        packageBadgeMap.get(p.package_id)?.has(badgeId));
      if (conflictPkg) {
        pendingAction = {
          scope: 'badge-move', id: badgeModalPackageId,
          payload: { badgeId, conflictPackageId: conflictPkg.package_id, badgeLabel: def.label, conflictPackageName: conflictPkg.package_name }
        };
        confirmTitle.textContent = 'Move Badge';
        confirmCopy.textContent  = `"${def.label}" is currently on "${conflictPkg.package_name}". Move it to "${pkg.package_name}"?`;
        confirmOk.textContent    = 'Move';
        confirmOk.className      = 'btn-primary';
        setModalMsg(confirmMessage, '');
        openModal(confirmModal);
        btn.disabled = false;
        return;
      }
      const { error } = await supabase.from(PACKAGE_BADGE_TABLE).insert({ package_id: badgeModalPackageId, badge_id: badgeId });
      if (error) throw error;
      if (!packageBadgeMap.has(badgeModalPackageId)) packageBadgeMap.set(badgeModalPackageId, new Set());
      packageBadgeMap.get(badgeModalPackageId).add(badgeId);
      await logAudit({ action: 'Assigned Badge', category: 'package', details: `Assigned "${def.label}" to ${pkg.package_name}`, entityId: badgeModalPackageId });
    } else {
      // No uniqueness constraint (e.g. a promo label) — assign directly.
      const { error } = await supabase.from(PACKAGE_BADGE_TABLE).insert({ package_id: badgeModalPackageId, badge_id: badgeId });
      if (error) throw error;
      if (!packageBadgeMap.has(badgeModalPackageId)) packageBadgeMap.set(badgeModalPackageId, new Set());
      packageBadgeMap.get(badgeModalPackageId).add(badgeId);
      await logAudit({ action: 'Assigned Badge', category: 'package', details: `Assigned "${def.label}" to ${pkg.package_name}`, entityId: badgeModalPackageId });
    }
    renderBadgeModal(pkg);
    renderInventory();
  } catch (err) {
    setModalMsg(badgeModalMessage, `Failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

badgeModalClose.addEventListener('click', () => closeModal(badgeModal));
badgeModalDone.addEventListener('click',  () => closeModal(badgeModal));
badgeModal.addEventListener('click', e => { if (e.target === badgeModal) closeModal(badgeModal); });

// ═══════════════════════════════════════════════════════════════════════════════
// PACKAGE TIER — right-anchored drawer (replaces the old below-table panel)
// ═══════════════════════════════════════════════════════════════════════════════
function trapFocus(container) {
  const focusables = container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (!focusables.length) return null;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  function handler(e) {
    if (e.key !== 'Tab') return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  }
  container.addEventListener('keydown', handler);
  first.focus();
  return handler;
}

function openTierDrawer(packageId, packageName, triggerEl) {
  tierForPackageId    = packageId;
  tierForPackageName  = packageName;
  tierDrawerTriggerEl = triggerEl || document.activeElement;

  tierDrawerTitle.textContent = packageName;

  tierDrawerScrim.classList.remove('hidden');
  tierDrawer.classList.add('open');
  tierDrawer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('tier-drawer-open');

  loadTiers(packageId);

  const trapHandler = trapFocus(tierDrawer);
  function escHandler(e) { if (e.key === 'Escape') closeTierDrawer(); }
  document.addEventListener('keydown', escHandler);
  tierDrawer._cleanup = () => {
    if (trapHandler) tierDrawer.removeEventListener('keydown', trapHandler);
    document.removeEventListener('keydown', escHandler);
  };
}

function closeTierDrawer() {
  tierDrawerScrim.classList.add('hidden');
  tierDrawer.classList.remove('open');
  tierDrawer.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('tier-drawer-open');
  if (tierDrawer._cleanup) { tierDrawer._cleanup(); tierDrawer._cleanup = null; }
  tierForPackageId   = null;
  tierForPackageName = '';
  if (tierDrawerTriggerEl && document.body.contains(tierDrawerTriggerEl)) tierDrawerTriggerEl.focus();
  tierDrawerTriggerEl = null;
}

tierDrawerClose.addEventListener('click', closeTierDrawer);
tierDrawerDone.addEventListener('click', closeTierDrawer);
tierDrawerScrim.addEventListener('click', closeTierDrawer);

async function loadTiers(packageId) {
  tierDrawerList.innerHTML = '<p class="modal-hint">Loading tiers...</p>';
  try {
    const { data, error } = await supabase
      .from(TIER_TABLE)
      .select('*')
      .eq('package_id', packageId)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    allTiers = data || [];
    renderTierTable();
  } catch (err) {
    tierDrawerList.innerHTML = `<p class="modal-hint">Failed to load tiers: ${escapeHtml(err.message)}</p>`;
  }
}

function medalClassForIndex(i) { return i === 0 ? 'bronze' : i === 1 ? 'silver' : i === 2 ? 'gold' : 'bronze'; }
function medalLabelForIndex(i) { return i === 0 ? 'B' : i === 1 ? 'S' : i === 2 ? 'G' : '•'; }

function renderTierTable() {
  if (allTiers.length === 0) {
    tierDrawerList.innerHTML = `<p class="modal-hint">Tiers let one package sell at several price points — Bronze, Silver, Gold. Add one to get started.</p>`;
    return;
  }

  tierDrawerList.innerHTML = allTiers.map((tier, i) => {
    const isArchived = !tier.is_active;
    const actions = isArchived
      ? `<button type="button" class="action-btn edit" data-tier-action="edit" data-id="${tier.tier_id}">Edit</button>
         <button type="button" class="action-btn restore" data-tier-action="restore" data-id="${tier.tier_id}" data-name="${escapeHtml(tier.tier_name)}">Restore</button>`
      : `<button type="button" class="action-btn edit" data-tier-action="edit" data-id="${tier.tier_id}">Edit</button>
         <button type="button" class="action-btn archive" data-tier-action="archive" data-id="${tier.tier_id}" data-name="${escapeHtml(tier.tier_name)}">Archive</button>`;
    return `
      <div class="tier-row" style="${isArchived ? 'opacity:.55' : ''}">
        <span class="medal-chip ${medalClassForIndex(i)}">${medalLabelForIndex(i)}</span>
        <div>
          <div class="tier-row-name">${escapeHtml(tier.tier_name)}${isArchived ? ' (archived)' : ''}</div>
          <div class="tier-row-sub">${escapeHtml(tier.tier_subtitle || '—')}</div>
        </div>
        <div class="tier-row-actions">${actions}</div>
      </div>`;
  }).join('');
}

function handleTierTableAction(e) {
  const btn = e.target.closest('[data-tier-action]');
  if (!btn) return;
  const { tierAction, id, name } = btn.dataset;
  if (tierAction === 'edit')    openEditTierModal(id);
  if (tierAction === 'archive') openConfirmTierArchive(id, name);
  if (tierAction === 'restore') openConfirmTierRestore(id, name);
}

tierDrawerList.addEventListener('click', handleTierTableAction);

// ─── Tier Modal: Add / Edit ───────────────────────────────────────────────────
function clearTierForm() {
  tierNameInput.value      = '';
  tierSubtitle.value       = '';
  tierFullInclusions.value = '';
  tierSortOrder.value      = '0';
}

function openAddTierModal() {
  editingTierId = null;
  tierModalTitle.textContent     = 'Add Tier';
  tierModalSub.textContent       = `Add a tier to "${tierForPackageName}"`;
  tierModalSaveLabel.textContent = 'Add Tier';
  clearTierForm();
  setModalMsg(tierModalMessage, '');
  openModal(tierModal);
}

function openEditTierModal(tierId) {
  const tier = allTiers.find(t => t.tier_id === tierId);
  if (!tier) return;

  editingTierId = tierId;
  tierModalTitle.textContent     = 'Edit Tier';
  tierModalSub.textContent       = `Edit "${tier.tier_name}" tier`;
  tierModalSaveLabel.textContent = 'Save Changes';

  tierNameInput.value      = tier.tier_name || '';
  tierSubtitle.value       = tier.tier_subtitle || '';
  tierFullInclusions.value = tier.tier_full_inclusions || '';
  tierSortOrder.value      = tier.sort_order ?? 0;

  setModalMsg(tierModalMessage, '');
  openModal(tierModal);
}

tierModalSave.addEventListener('click', async () => {
  const name = tierNameInput.value.trim();
  if (!name) { setModalMsg(tierModalMessage, 'Tier name is required.'); return; }

  tierModalSave.disabled = true;
  tierModalSaveLabel.textContent = 'Saving…';
  setModalMsg(tierModalMessage, '');

  try {
    const payload = {
      tier_name:           name,
      tier_subtitle:       tierSubtitle.value.trim() || null,
      tier_full_inclusions: normalizeTierInclusions(tierFullInclusions.value) || null,
      sort_order:          parseInt(tierSortOrder.value, 10) || 0,
      package_id:          tierForPackageId,
    };

    if (editingTierId) {
      const { data, error } = await supabase
        .from(TIER_TABLE)
        .update(payload)
        .eq('tier_id', editingTierId)
        .select()
        .single();
      if (error) throw error;
      const idx = allTiers.findIndex(t => t.tier_id === editingTierId);
      if (idx !== -1) allTiers[idx] = data;
      await logAudit({
        action:   'Updated Tier',
        category: 'package',
        details:  `Tier updated: ${name} (Package: ${tierForPackageName})`,
        entityId: editingTierId
      });
    } else {
      payload.is_active = true;
      const { data, error } = await supabase
        .from(TIER_TABLE)
        .insert(payload)
        .select()
        .single();
      if (error) throw error;
      allTiers.push(data);
      await logAudit({
        action:   'Added Tier',
        category: 'package',
        details:  `New tier created: ${name} (Package: ${tierForPackageName})`,
        entityId: data.tier_id
      });
    }

    allTiers.sort((a, b) => a.sort_order - b.sort_order);
    renderTierTable();
    allTiersByPackage.set(tierForPackageId, allTiers.filter(t => t.is_active));
    renderInventory();
    closeModal(tierModal);
  } catch (err) {
    setModalMsg(tierModalMessage, `Failed to save: ${err.message}`);
  } finally {
    tierModalSave.disabled = false;
    tierModalSaveLabel.textContent = editingTierId ? 'Save Changes' : 'Add Tier';
  }
});

// ─── Tier Archive / Restore ───────────────────────────────────────────────────
function openConfirmTierArchive(tierId, tierNameText) {
  pendingAction = { scope: 'tier', type: 'archive', id: tierId };
  confirmTitle.textContent = 'Archive Tier';
  confirmCopy.textContent  = `Are you sure you want to archive the "${tierNameText}" tier?`;
  confirmOk.textContent    = 'Archive';
  confirmOk.className      = 'btn-danger';
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

function openConfirmTierRestore(tierId, tierNameText) {
  pendingAction = { scope: 'tier', type: 'restore', id: tierId };
  confirmTitle.textContent = 'Restore Tier';
  confirmCopy.textContent  = `Restore the "${tierNameText}" tier?`;
  confirmOk.textContent    = 'Restore';
  confirmOk.className      = 'btn-primary';
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

// ─── Tier Modal close handlers ────────────────────────────────────────────────
tierModalClose.addEventListener('click',  () => closeModal(tierModal));
tierModalCancel.addEventListener('click', () => closeModal(tierModal));
tierModal.addEventListener('click', e => { if (e.target === tierModal) closeModal(tierModal); });

// ═══════════════════════════════════════════════════════════════════════════════
// PACKAGE: REORDER (move up/down among active siblings in the same category —
// this directly drives display order on the customer Packages page)
// ═══════════════════════════════════════════════════════════════════════════════
function getCategorySiblings(pkg) {
  return allPackages
    .filter(p => p.package_category_id === pkg.package_category_id && p.is_active)
    .sort((a, b) => (a.sort_order - b.sort_order) || (new Date(b.created_at) - new Date(a.created_at)));
}

async function movePackage(packageId, direction) {
  const pkg = allPackages.find(p => p.package_id === packageId);
  if (!pkg || !pkg.is_active) return;

  const siblings = getCategorySiblings(pkg);
  const index = siblings.findIndex(p => p.package_id === packageId);
  const targetIndex = index + direction;
  if (index === -1 || targetIndex < 0 || targetIndex >= siblings.length) return;

  [siblings[index], siblings[targetIndex]] = [siblings[targetIndex], siblings[index]];

  setMessage(inventoryPageMessage, 'Reordering…');
  try {
    await Promise.all(siblings.map((p, i) => {
      if (p.sort_order === i) return Promise.resolve();
      p.sort_order = i;
      return supabase.from('package').update({ sort_order: i }).eq('package_id', p.package_id);
    }));
    await logAudit({
      action: 'Reordered Packages',
      category: 'package',
      details: `Moved "${pkg.package_name}" ${direction < 0 ? 'up' : 'down'}`,
      entityId: packageId
    });
    setMessage(inventoryPageMessage, 'Order updated.', 'success');
    renderInventory();
  } catch (err) {
    setMessage(inventoryPageMessage, `Failed to reorder: ${err.message}`, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PACKAGE ACTION DISPATCH (shared by card kebab, list-row kebab, tier-ladder link)
// ═══════════════════════════════════════════════════════════════════════════════
function handlePkgTableAction(e) {
  const btn = e.target.closest('[data-pkg-action]');
  if (!btn) return;
  const { pkgAction, id, name } = btn.dataset;
  if (pkgAction === 'edit')      openEditPackageModal(id);
  if (pkgAction === 'archive')   openConfirmArchivePackage(id);
  if (pkgAction === 'restore')   openConfirmRestorePackage(id);
  if (pkgAction === 'tiers')     openTierDrawer(id, name, btn);
  if (pkgAction === 'badges')    openBadgeModal(id);
  if (pkgAction === 'delete')    openConfirmDeletePackage(id);
  if (pkgAction === 'duplicate') duplicatePackage(id);
  if (pkgAction === 'move-up')   movePackage(id, -1);
  if (pkgAction === 'move-down') movePackage(id, 1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// VENUES
// ═══════════════════════════════════════════════════════════════════════════════
async function loadVenues() {
  setMessage(venuePageMessage, 'Loading venues…');
  try {
    const { data, error } = await supabase
      .from(VENUE_TABLE)
      .select('*')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });
    if (error) throw error;
    allVenues = data || [];

    // Mapped-package counts, one query for all venues.
    const { data: mappings } = await supabase.from(PACKAGE_VENUE_TABLE).select('venue_id');
    const counts = {};
    (mappings || []).forEach(m => { counts[m.venue_id] = (counts[m.venue_id] || 0) + 1; });
    allVenues.forEach(v => { v._mappedCount = counts[v.venue_id] || 0; });

    renderVenueTables();
    setMessage(venuePageMessage, '');
  } catch (err) {
    setMessage(venuePageMessage, `Failed to load venues: ${err.message}`, 'error');
  }
}

function buildVenueRow(venue) {
  const isArchived = !venue.is_active;
  const actions = isArchived
    ? `<div class="action-cell">
        <button class="action-btn edit" data-venue-action="edit" data-id="${venue.venue_id}">Edit</button>
        <button class="action-btn restore" data-venue-action="restore" data-id="${venue.venue_id}">Restore</button>
        <button class="action-btn archive" data-venue-action="delete" data-id="${venue.venue_id}">Delete</button>
      </div>`
    : `<div class="action-cell">
        <button class="action-btn edit" data-venue-action="edit" data-id="${venue.venue_id}">Edit</button>
        <button class="action-btn archive" data-venue-action="archive" data-id="${venue.venue_id}">Archive</button>
        <button class="action-btn archive" data-venue-action="delete" data-id="${venue.venue_id}">Delete</button>
      </div>`;

  return `<tr>
    <td>
      <div class="pkg-name">${escapeHtml(venue.name)}</div>
      ${venue.description ? `<div class="pkg-id">${escapeHtml(venue.description)}</div>` : ''}
    </td>
    <td>${venue.capacity} pax</td>
    <td><span class="count-pill">${venue._mappedCount || 0} package${venue._mappedCount === 1 ? '' : 's'}</span></td>
    <td>${venue.sort_order}</td>
    <td><span class="status-pill ${isArchived ? 'archived' : 'active'}">${isArchived ? 'Archived' : 'Active'}</span></td>
    <td>${actions}</td>
  </tr>`;
}

function renderVenueTables() {
  const active = allVenues.filter(v => v.is_active);
  const archived = allVenues.filter(v => !v.is_active);

  activeVenueBody.innerHTML = active.length
    ? active.map(buildVenueRow).join('')
    : '<tr class="empty-row"><td colspan="6">No venues yet. Add Main Hall, Garden, or VIP so onsite packages have somewhere to go.</td></tr>';

  archivedVenueSection.style.display = archived.length ? '' : 'none';
  archivedVenueBody.innerHTML = archived.length
    ? archived.map(buildVenueRow).join('')
    : '';
}

function handleVenueTableAction(e) {
  const btn = e.target.closest('[data-venue-action]');
  if (!btn) return;
  const { venueAction, id } = btn.dataset;
  if (venueAction === 'edit')    openEditVenueModal(id);
  if (venueAction === 'archive') openConfirmArchiveVenue(id);
  if (venueAction === 'restore') openConfirmRestoreVenue(id);
  if (venueAction === 'delete')  openConfirmDeleteVenue(id);
}

activeVenueBody.addEventListener('click', handleVenueTableAction);
archivedVenueBody.addEventListener('click', handleVenueTableAction);

function openAddVenueModal() {
  editingVenueId = null;
  venueModalTitle.textContent = 'Add New Venue';
  venueModalSub.textContent = 'A physical space at the café';
  venueModalSaveLabel.textContent = 'Add Venue';
  venueName.value = '';
  venueCapacity.value = '';
  venueDescription.value = '';
  venueSortOrder.value = '0';
  venueMappedPackagesField.style.display = 'none';
  setModalMsg(venueModalMessage, '');
  openModal(venueModal);
}

async function openEditVenueModal(venueId) {
  const venue = allVenues.find(v => v.venue_id === venueId);
  if (!venue) return;

  editingVenueId = venueId;
  venueModalTitle.textContent = 'Edit Venue';
  venueModalSub.textContent = 'Update venue details';
  venueModalSaveLabel.textContent = 'Save Changes';
  venueName.value = venue.name || '';
  venueCapacity.value = venue.capacity ?? '';
  venueDescription.value = venue.description || '';
  venueSortOrder.value = venue.sort_order ?? 0;

  setModalMsg(venueModalMessage, '');
  openModal(venueModal);

  try {
    const mapped = await getVenueMappedPackages(venueId);
    if (mapped.length) {
      venueMappedPackagesField.style.display = '';
      venueMappedPackagesList.innerHTML = mapped.map(p => `<div class="checklist-item met">• ${escapeHtml(p.package_name)}</div>`).join('');
    } else {
      venueMappedPackagesField.style.display = 'none';
    }
  } catch {
    venueMappedPackagesField.style.display = 'none';
  }
}

venueModalSave.addEventListener('click', async () => {
  const name = venueName.value.trim();
  const capacity = parseInt(venueCapacity.value, 10);
  if (!name) { setModalMsg(venueModalMessage, 'Venue name is required.'); return; }
  if (!capacity || capacity < 1) { setModalMsg(venueModalMessage, 'A valid capacity is required.'); return; }

  venueModalSave.disabled = true;
  venueModalSaveLabel.textContent = 'Saving…';
  setModalMsg(venueModalMessage, '');

  try {
    const payload = {
      name,
      capacity,
      description: venueDescription.value.trim() || null,
      sort_order: parseInt(venueSortOrder.value, 10) || 0,
    };

    if (editingVenueId) {
      const { data, error } = await supabase.from(VENUE_TABLE).update(payload).eq('venue_id', editingVenueId).select().single();
      if (error) throw error;
      const idx = allVenues.findIndex(v => v.venue_id === editingVenueId);
      if (idx !== -1) allVenues[idx] = { ...allVenues[idx], ...data };
      await logAudit({ action: 'Updated Venue', category: 'package', details: `Venue updated: ${name}`, entityId: editingVenueId });
      setMessage(venuePageMessage, 'Venue updated successfully.', 'success');
    } else {
      payload.is_active = true;
      const { data, error } = await supabase.from(VENUE_TABLE).insert(payload).select().single();
      if (error) throw error;
      data._mappedCount = 0;
      allVenues.unshift(data);
      await logAudit({ action: 'Added Venue', category: 'package', details: `New venue created: ${name}`, entityId: data.venue_id });
      setMessage(venuePageMessage, 'Venue added successfully.', 'success');
    }

    renderVenueTables();
    closeModal(venueModal);
  } catch (err) {
    setModalMsg(venueModalMessage, `Failed to save: ${err.message}`);
  } finally {
    venueModalSave.disabled = false;
    venueModalSaveLabel.textContent = editingVenueId ? 'Save Changes' : 'Add Venue';
  }
});

addVenueBtn.addEventListener('click', openAddVenueModal);
venueModalClose.addEventListener('click',  () => closeModal(venueModal));
venueModalCancel.addEventListener('click', () => closeModal(venueModal));
venueModal.addEventListener('click', e => { if (e.target === venueModal) closeModal(venueModal); });

function openConfirmArchiveVenue(venueId) {
  const venue = allVenues.find(v => v.venue_id === venueId);
  if (!venue) return;
  pendingAction = { scope: 'venue', type: 'archive', id: venueId };
  confirmTitle.textContent = 'Archive Venue';
  confirmOk.textContent    = 'Archive';
  confirmOk.className      = 'btn-danger';
  setModalMsg(confirmMessage, '');
  confirmCopy.textContent  = `Archive "${venue.name}"? It will no longer be selectable when mapping onsite packages.`;
  openModal(confirmModal);

  // Best-effort enrichment: name the packages this would affect once known.
  getVenueMappedPackages(venueId).then(mapped => {
    if (mapped.length && pendingAction && pendingAction.id === venueId) {
      confirmCopy.textContent = `Archive "${venue.name}"? It's currently mapped to ${mapped.map(p => p.package_name).join(', ')} — they'll keep their existing mapping, but you won't be able to add this venue to new packages until it's restored.`;
    }
  }).catch(() => { /* best-effort only */ });
}

function openConfirmRestoreVenue(venueId) {
  const venue = allVenues.find(v => v.venue_id === venueId);
  if (!venue) return;
  pendingAction = { scope: 'venue', type: 'restore', id: venueId };
  confirmTitle.textContent = 'Restore Venue';
  confirmCopy.textContent  = `Restore "${venue.name}"?`;
  confirmOk.textContent    = 'Restore';
  confirmOk.className      = 'btn-primary';
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

// Venue delete: package_venue.venue_id is ON DELETE RESTRICT, so this is
// already blocked at the DB level while mapped — this just turns that into
// a friendly message naming the blocking packages instead of a raw error.
async function openConfirmDeleteVenue(venueId) {
  const venue = allVenues.find(v => v.venue_id === venueId);
  if (!venue) return;

  setMessage(venuePageMessage, 'Checking mapped packages…');
  let mapped;
  try {
    mapped = await getVenueMappedPackages(venueId);
  } catch (err) {
    setMessage(venuePageMessage, `Failed to check packages: ${err.message}`, 'error');
    return;
  }
  setMessage(venuePageMessage, '');

  deleteReassignField.classList.add('hidden');

  if (mapped.length) {
    pendingDeleteAction = { scope: 'venue', id: venueId, mode: 'blocked' };
    deleteModalTitle.textContent = 'Venue In Use';
    deleteModalCopy.textContent = `"${venue.name}" is mapped to: ${mapped.map(p => p.package_name).join(', ')}. Remove it from those packages' Venues section first, or Cancel and Archive instead.`;
    deleteModalOk.disabled = true;
  } else {
    pendingDeleteAction = { scope: 'venue', id: venueId, mode: 'delete' };
    deleteModalTitle.textContent = 'Delete Venue';
    deleteModalCopy.textContent = `Delete "${venue.name}"? This can't be undone.`;
    deleteModalOk.disabled = false;
  }
  deleteModalOk.textContent = 'Delete';
  setModalMsg(deleteModalMessage, '');
  openModal(deleteModal);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BADGE TYPES (Best Value, Popular, and any admin-defined labels — Best
// Seller is excluded: it has its own automatic/manual mode switch inside the
// per-package Badges panel and shouldn't be edited/archived/deleted here)
// ═══════════════════════════════════════════════════════════════════════════════
const SCOPE_LABELS = { category: 'One per category', global: 'One overall' };

function slugifyBadgeKey(label) {
  const base = label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'badge';
  let candidate = base;
  let n = 2;
  while (allBadgeDefs.some(b => b.badge_key === candidate)) {
    candidate = `${base}_${n}`;
    n++;
  }
  return candidate;
}

// In-memory — packageBadgeMap is already fully loaded by loadInventory, so
// this needs no extra round trip (mirrors the venue mapped-count pattern).
function countBadgeTypeUsage(badgeId) {
  let count = 0;
  packageBadgeMap.forEach(set => { if (set.has(badgeId)) count++; });
  return count;
}

function manageableBadgeTypes() {
  return allBadgeDefs.filter(b => b.badge_key !== 'best_seller');
}

function buildBadgeTypeRow(badge) {
  const isArchived = !badge.is_active;
  const usage = countBadgeTypeUsage(badge.badge_id);
  const actions = isArchived
    ? `<div class="action-cell">
        <button class="action-btn edit" data-badgetype-action="edit" data-id="${badge.badge_id}">Edit</button>
        <button class="action-btn restore" data-badgetype-action="restore" data-id="${badge.badge_id}">Restore</button>
        <button class="action-btn archive" data-badgetype-action="delete" data-id="${badge.badge_id}">Delete</button>
      </div>`
    : `<div class="action-cell">
        <button class="action-btn edit" data-badgetype-action="edit" data-id="${badge.badge_id}">Edit</button>
        <button class="action-btn archive" data-badgetype-action="archive" data-id="${badge.badge_id}">Archive</button>
        <button class="action-btn archive" data-badgetype-action="delete" data-id="${badge.badge_id}">Delete</button>
      </div>`;

  return `<tr>
    <td><span class="pkg-badge-chip pkg-badge-chip--${escapeHtml(badge.variant)}">${escapeHtml(badge.label)}</span></td>
    <td>${SCOPE_LABELS[badge.unique_scope] || 'No limit'}</td>
    <td><span class="count-pill">${usage} package${usage === 1 ? '' : 's'}</span></td>
    <td>${badge.sort_order}</td>
    <td><span class="status-pill ${isArchived ? 'archived' : 'active'}">${isArchived ? 'Archived' : 'Active'}</span></td>
    <td>${actions}</td>
  </tr>`;
}

function renderBadgeTypesTables() {
  const manageable = manageableBadgeTypes();
  const active = manageable.filter(b => b.is_active);
  const archived = manageable.filter(b => !b.is_active);

  activeBadgeTypesBody.innerHTML = active.length
    ? active.map(buildBadgeTypeRow).join('')
    : '<tr class="empty-row"><td colspan="6">No badge types yet. Add one so admins have something to assign.</td></tr>';

  archivedBadgeTypesSection.style.display = archived.length ? '' : 'none';
  archivedBadgeTypesBody.innerHTML = archived.length
    ? archived.map(buildBadgeTypeRow).join('')
    : '';
}

function handleBadgeTypeTableAction(e) {
  const btn = e.target.closest('[data-badgetype-action]');
  if (!btn) return;
  const { badgetypeAction, id } = btn.dataset;
  if (badgetypeAction === 'edit')    openEditBadgeTypeModal(id);
  if (badgetypeAction === 'archive') openConfirmArchiveBadgeType(id);
  if (badgetypeAction === 'restore') openConfirmRestoreBadgeType(id);
  if (badgetypeAction === 'delete')  openConfirmDeleteBadgeType(id);
}

activeBadgeTypesBody.addEventListener('click', handleBadgeTypeTableAction);
archivedBadgeTypesBody.addEventListener('click', handleBadgeTypeTableAction);

function openAddBadgeTypeModal() {
  editingBadgeTypeId = null;
  badgeTypeModalTitle.textContent = 'Add New Badge Type';
  badgeTypeModalSub.textContent = 'A label admins can assign to any package';
  badgeTypeModalSaveLabel.textContent = 'Add Badge Type';
  badgeTypeLabelInput.value = '';
  badgeTypeVariantSelect.value = 'neutral';
  badgeTypeScopeSelect.value = '';
  badgeTypeSortOrder.value = '0';
  setModalMsg(badgeTypeModalMessage, '');
  openModal(badgeTypeModal);
}

function openEditBadgeTypeModal(badgeId) {
  const badge = allBadgeDefs.find(b => b.badge_id === badgeId);
  if (!badge) return;

  editingBadgeTypeId = badgeId;
  badgeTypeModalTitle.textContent = 'Edit Badge Type';
  badgeTypeModalSub.textContent = 'Update this badge’s label, colour, or rules';
  badgeTypeModalSaveLabel.textContent = 'Save Changes';
  badgeTypeLabelInput.value = badge.label || '';
  badgeTypeVariantSelect.value = badge.variant || 'neutral';
  badgeTypeScopeSelect.value = badge.unique_scope || '';
  badgeTypeSortOrder.value = badge.sort_order ?? 0;
  setModalMsg(badgeTypeModalMessage, '');
  openModal(badgeTypeModal);
}

badgeTypeModalSave.addEventListener('click', async () => {
  const label = badgeTypeLabelInput.value.trim();
  if (!label) { setModalMsg(badgeTypeModalMessage, 'A label is required.'); return; }

  badgeTypeModalSave.disabled = true;
  badgeTypeModalSaveLabel.textContent = 'Saving…';
  setModalMsg(badgeTypeModalMessage, '');

  try {
    const payload = {
      label,
      variant: badgeTypeVariantSelect.value,
      unique_scope: badgeTypeScopeSelect.value || null,
      sort_order: parseInt(badgeTypeSortOrder.value, 10) || 0,
    };

    if (editingBadgeTypeId) {
      const { data, error } = await supabase.from(BADGE_TABLE).update(payload).eq('badge_id', editingBadgeTypeId).select().single();
      if (error) throw error;
      const idx = allBadgeDefs.findIndex(b => b.badge_id === editingBadgeTypeId);
      if (idx !== -1) allBadgeDefs[idx] = { ...allBadgeDefs[idx], ...data };
      await logAudit({ action: 'Updated Badge Type', category: 'package', details: `Badge type updated: ${label}`, entityId: editingBadgeTypeId });
      setMessage(badgeTypesPageMessage, 'Badge type updated successfully.', 'success');
    } else {
      payload.badge_key = slugifyBadgeKey(label);
      payload.is_assignable = true;
      payload.is_active = true;
      const { data, error } = await supabase.from(BADGE_TABLE).insert(payload).select().single();
      if (error) throw error;
      allBadgeDefs.push(data);
      await logAudit({ action: 'Added Badge Type', category: 'package', details: `New badge type created: ${label}`, entityId: data.badge_id });
      setMessage(badgeTypesPageMessage, 'Badge type added successfully.', 'success');
    }

    renderBadgeTypesTables();
    renderInventory();
    closeModal(badgeTypeModal);
  } catch (err) {
    setModalMsg(badgeTypeModalMessage, `Failed to save: ${err.message}`);
  } finally {
    badgeTypeModalSave.disabled = false;
    badgeTypeModalSaveLabel.textContent = editingBadgeTypeId ? 'Save Changes' : 'Add Badge Type';
  }
});

addBadgeTypeBtn.addEventListener('click', openAddBadgeTypeModal);
badgeTypeModalClose.addEventListener('click',  () => closeModal(badgeTypeModal));
badgeTypeModalCancel.addEventListener('click', () => closeModal(badgeTypeModal));
badgeTypeModal.addEventListener('click', e => { if (e.target === badgeTypeModal) closeModal(badgeTypeModal); });

function openConfirmArchiveBadgeType(badgeId) {
  const badge = allBadgeDefs.find(b => b.badge_id === badgeId);
  if (!badge) return;
  const usage = countBadgeTypeUsage(badgeId);
  pendingAction = { scope: 'badge-type', type: 'archive', id: badgeId };
  confirmTitle.textContent = 'Archive Badge Type';
  confirmCopy.textContent  = usage
    ? `Archive "${badge.label}"? It's currently on ${usage} package${usage === 1 ? '' : 's'} — they'll keep it, but it can't be assigned to anything new until restored.`
    : `Archive "${badge.label}"? It will no longer be assignable to packages.`;
  confirmOk.textContent    = 'Archive';
  confirmOk.className      = 'btn-danger';
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

function openConfirmRestoreBadgeType(badgeId) {
  const badge = allBadgeDefs.find(b => b.badge_id === badgeId);
  if (!badge) return;
  pendingAction = { scope: 'badge-type', type: 'restore', id: badgeId };
  confirmTitle.textContent = 'Restore Badge Type';
  confirmCopy.textContent  = `Restore "${badge.label}" and make it assignable again?`;
  confirmOk.textContent    = 'Restore';
  confirmOk.className      = 'btn-primary';
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

// Badge type delete: package_badge.badge_id is ON DELETE CASCADE, so a raw
// delete would silently strip the badge off every package holding it —
// guard with the same reference check used for package delete, offering
// Archive instead when it's actually in use.
function openConfirmDeleteBadgeType(badgeId) {
  const badge = allBadgeDefs.find(b => b.badge_id === badgeId);
  if (!badge) return;
  const usage = countBadgeTypeUsage(badgeId);

  deleteReassignField.classList.add('hidden');

  if (usage > 0) {
    pendingDeleteAction = { scope: 'badge-type', id: badgeId, mode: 'archive' };
    deleteModalTitle.textContent = 'Archive Instead';
    deleteModalCopy.textContent  = `${usage} package${usage === 1 ? '' : 's'} currently hold "${badge.label}". Archive it instead — they'll keep it, but it can't be assigned to anything new.`;
    deleteModalOk.textContent    = 'Archive';
  } else {
    pendingDeleteAction = { scope: 'badge-type', id: badgeId, mode: 'delete' };
    deleteModalTitle.textContent = 'Delete Badge Type';
    deleteModalCopy.textContent  = `Delete "${badge.label}"? This can't be undone.`;
    deleteModalOk.textContent    = 'Delete';
  }
  deleteModalOk.disabled = false;
  setModalMsg(deleteModalMessage, '');
  openModal(deleteModal);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATERING MENU (catering_dish_category + catering_dish) — backs the buffet
// builder on reservations.html. Categories are the selectable groups
// (Chicken, Pasta, Drinks...); dishes are the items inside each.
// ═══════════════════════════════════════════════════════════════════════════════
const CATERING_TAG_LABELS = { main: 'Main dish', pasta: 'Pasta', dessert: 'Dessert', rice: 'Rice', drinks: 'Drinks', addon: 'Add-on' };

async function loadCateringMenuPackages() {
  setMessage(cateringPageMessage, 'Loading catering packages…');
  try {
    const { data, error } = await supabase
      .from('package')
      .select('package_id, package_name, is_active')
      .eq('uses_catering_menu', true)
      .order('sort_order', { ascending: true });
    if (error) throw error;

    cateringMenuPackages = data || [];

    if (!cateringMenuPackages.length) {
      cateringMenuActivePackageId = null;
      cateringPackageSelect.innerHTML = '';
      cateringPackagePickerCard.style.display = 'none';
      activeCateringSection.style.display = 'none';
      archivedCateringSection.style.display = 'none';
      addCateringCategoryBtn.disabled = true;
      setMessage(cateringPageMessage,
        'No catering-enabled packages yet. In Inventory, edit a package and check "Uses the customizable catering menu" to manage its menu here.',
        'error');
      return;
    }

    addCateringCategoryBtn.disabled = false;
    cateringPackagePickerCard.style.display = '';
    activeCateringSection.style.display = '';

    // Keep the previous selection if it's still a valid catering package, else default to the first.
    if (!cateringMenuActivePackageId || !cateringMenuPackages.some(p => p.package_id === cateringMenuActivePackageId)) {
      cateringMenuActivePackageId = cateringMenuPackages[0].package_id;
    }

    cateringPackageSelect.innerHTML = cateringMenuPackages
      .map(p => `<option value="${p.package_id}" ${p.package_id === cateringMenuActivePackageId ? 'selected' : ''}>${escapeHtml(p.package_name)}${p.is_active ? '' : ' (Archived package)'}</option>`)
      .join('');

    setMessage(cateringPageMessage, '');
    await loadCateringMenu();
  } catch (err) {
    setMessage(cateringPageMessage, `Failed to load catering packages: ${err.message}`, 'error');
  }
}

cateringPackageSelect.addEventListener('change', async () => {
  cateringMenuActivePackageId = cateringPackageSelect.value || null;
  await loadCateringMenu();
});

async function loadCateringMenu() {
  if (!cateringMenuActivePackageId) { allCateringCategories = []; allCateringDishes = []; renderCateringTables(); return; }
  setMessage(cateringPageMessage, 'Loading catering menu…');
  try {
    const [{ data: cats, error: catErr }, { data: dishes, error: dishErr }] = await Promise.all([
      supabase.from(CATERING_CATEGORY_TABLE).select('*').eq('package_id', cateringMenuActivePackageId).order('sort_order', { ascending: true }),
      supabase.from(CATERING_DISH_TABLE).select('*').order('sort_order', { ascending: true }),
    ]);
    if (catErr) throw catErr;
    if (dishErr) throw dishErr;
    allCateringCategories = cats || [];
    allCateringDishes = dishes || [];
    renderCateringTables();
    setMessage(cateringPageMessage, '');
  } catch (err) {
    setMessage(cateringPageMessage, `Failed to load catering menu: ${err.message}`, 'error');
  }
}

function dishesForCategory(categoryId) {
  return allCateringDishes.filter(d => d.category_id === categoryId);
}

function cateringPriceSummary(cat) {
  return `${formatCurrency(cat.price_20)} / ${formatCurrency(cat.price_30)} / ${formatCurrency(cat.price_40)} / ${formatCurrency(cat.price_50)}`;
}

function buildCateringCategoryRow(cat) {
  const isArchived = !cat.is_active;
  const dishes = dishesForCategory(cat.category_id);
  const activeDishCount = dishes.filter(d => d.is_active).length;
  const actions = isArchived
    ? `<div class="action-cell">
        <button class="action-btn edit" data-catering-action="edit" data-id="${cat.category_id}">Edit</button>
        <button class="action-btn restore" data-catering-action="restore" data-id="${cat.category_id}">Restore</button>
        <button class="action-btn archive" data-catering-action="delete" data-id="${cat.category_id}">Delete</button>
      </div>`
    : `<div class="action-cell">
        <button class="action-btn tiers" data-catering-action="dishes" data-id="${cat.category_id}">Dishes</button>
        <button class="action-btn edit" data-catering-action="edit" data-id="${cat.category_id}">Edit</button>
        <button class="action-btn archive" data-catering-action="archive" data-id="${cat.category_id}">Archive</button>
        <button class="action-btn archive" data-catering-action="delete" data-id="${cat.category_id}">Delete</button>
      </div>`;

  return `<tr>
    <td>${cat.icon ? cat.icon + ' ' : ''}${escapeHtml(cat.name)} <span class="category-pill">${CATERING_TAG_LABELS[cat.tag] || cat.tag}</span></td>
    <td>${cat.is_required ? 'Required' : 'Optional'}</td>
    <td><span class="count-pill">${activeDishCount} dish${activeDishCount === 1 ? '' : 'es'}</span></td>
    <td>${cateringPriceSummary(cat)}</td>
    <td>${cat.sort_order}</td>
    <td><span class="status-pill ${isArchived ? 'archived' : 'active'}">${isArchived ? 'Archived' : 'Active'}</span></td>
    <td>${actions}</td>
  </tr>`;
}

function renderCateringTables() {
  const active = allCateringCategories.filter(c => c.is_active);
  const archived = allCateringCategories.filter(c => !c.is_active);

  activeCateringBody.innerHTML = active.length
    ? active.map(buildCateringCategoryRow).join('')
    : '<tr class="empty-row"><td colspan="7">No categories yet. Add one so customers have something to pick from.</td></tr>';

  archivedCateringSection.style.display = archived.length ? '' : 'none';
  archivedCateringBody.innerHTML = archived.length ? archived.map(buildCateringCategoryRow).join('') : '';
}

function handleCateringCategoryTableAction(e) {
  const btn = e.target.closest('[data-catering-action]');
  if (!btn) return;
  const { cateringAction, id } = btn.dataset;
  if (cateringAction === 'edit')    openEditCateringCategoryModal(id);
  if (cateringAction === 'dishes')  openCateringDishDrawer(id, btn);
  if (cateringAction === 'archive') openConfirmArchiveCateringCategory(id);
  if (cateringAction === 'restore') openConfirmRestoreCateringCategory(id);
  if (cateringAction === 'delete')  openConfirmDeleteCateringCategory(id);
}

activeCateringBody.addEventListener('click', handleCateringCategoryTableAction);
archivedCateringBody.addEventListener('click', handleCateringCategoryTableAction);

// ─── Category Modal: Add / Edit ────────────────────────────────────────────────
function openAddCateringCategoryModal() {
  if (!cateringMenuActivePackageId) return; // guarded by the disabled button too
  editingCateringCategoryId = null;
  cateringCategoryModalTitle.textContent = 'Add New Category';
  const activePkg = cateringMenuPackages.find(p => p.package_id === cateringMenuActivePackageId);
  cateringCategoryModalSub.textContent = activePkg ? `For "${activePkg.package_name}"` : 'A selectable group in the buffet builder';
  cateringCategoryModalSaveLabel.textContent = 'Add Category';
  cateringCatName.value = '';
  cateringCatIcon.value = '';
  cateringCatTag.value = 'main';
  cateringCatSortOrder.value = '0';
  cateringCatRequired.checked = true;
  cateringPrice20.value = '';
  cateringPrice30.value = '';
  cateringPrice40.value = '';
  cateringPrice50.value = '';
  setModalMsg(cateringCategoryModalMessage, '');
  openModal(cateringCategoryModal);
}

function openEditCateringCategoryModal(categoryId) {
  const cat = allCateringCategories.find(c => c.category_id === categoryId);
  if (!cat) return;

  editingCateringCategoryId = categoryId;
  cateringCategoryModalTitle.textContent = 'Edit Category';
  cateringCategoryModalSub.textContent = `Update "${cat.name}"`;
  cateringCategoryModalSaveLabel.textContent = 'Save Changes';
  cateringCatName.value = cat.name || '';
  cateringCatIcon.value = cat.icon || '';
  cateringCatTag.value = cat.tag || 'main';
  cateringCatSortOrder.value = cat.sort_order ?? 0;
  cateringCatRequired.checked = !!cat.is_required;
  cateringPrice20.value = cat.price_20 ?? 0;
  cateringPrice30.value = cat.price_30 ?? 0;
  cateringPrice40.value = cat.price_40 ?? 0;
  cateringPrice50.value = cat.price_50 ?? 0;
  setModalMsg(cateringCategoryModalMessage, '');
  openModal(cateringCategoryModal);
}

cateringCategoryModalSave.addEventListener('click', async () => {
  const name = cateringCatName.value.trim();
  if (!name) { setModalMsg(cateringCategoryModalMessage, 'Category name is required.'); return; }

  const prices = [cateringPrice20, cateringPrice30, cateringPrice40, cateringPrice50].map(el => Number(el.value));
  if (prices.some(p => Number.isNaN(p) || p < 0)) {
    setModalMsg(cateringCategoryModalMessage, 'All four pax-bracket prices are required and must be 0 or more.');
    return;
  }

  cateringCategoryModalSave.disabled = true;
  cateringCategoryModalSaveLabel.textContent = 'Saving…';
  setModalMsg(cateringCategoryModalMessage, '');

  try {
    const payload = {
      name,
      icon: cateringCatIcon.value.trim() || null,
      tag: cateringCatTag.value,
      is_required: cateringCatRequired.checked,
      sort_order: parseInt(cateringCatSortOrder.value, 10) || 0,
      price_20: prices[0], price_30: prices[1], price_40: prices[2], price_50: prices[3],
    };

    if (editingCateringCategoryId) {
      const { data, error } = await supabase.from(CATERING_CATEGORY_TABLE).update(payload).eq('category_id', editingCateringCategoryId).select().single();
      if (error) throw error;
      const idx = allCateringCategories.findIndex(c => c.category_id === editingCateringCategoryId);
      if (idx !== -1) allCateringCategories[idx] = data;
      await logAudit({ action: 'Updated Catering Category', category: 'package', details: `Catering category updated: ${name}`, entityId: editingCateringCategoryId });
      setMessage(cateringPageMessage, 'Category updated successfully.', 'success');
    } else {
      if (!cateringMenuActivePackageId) throw new Error('No catering package selected.');
      payload.is_active = true;
      payload.package_id = cateringMenuActivePackageId;
      const { data, error } = await supabase.from(CATERING_CATEGORY_TABLE).insert(payload).select().single();
      if (error) throw error;
      allCateringCategories.push(data);
      await logAudit({ action: 'Added Catering Category', category: 'package', details: `New catering category created: ${name}`, entityId: data.category_id });
      setMessage(cateringPageMessage, 'Category added successfully.', 'success');
    }

    allCateringCategories.sort((a, b) => a.sort_order - b.sort_order);
    renderCateringTables();
    closeModal(cateringCategoryModal);
  } catch (err) {
    setModalMsg(cateringCategoryModalMessage, `Failed to save: ${err.message}`);
  } finally {
    cateringCategoryModalSave.disabled = false;
    cateringCategoryModalSaveLabel.textContent = editingCateringCategoryId ? 'Save Changes' : 'Add Category';
  }
});

addCateringCategoryBtn.addEventListener('click', openAddCateringCategoryModal);
cateringCategoryModalClose.addEventListener('click',  () => closeModal(cateringCategoryModal));
cateringCategoryModalCancel.addEventListener('click', () => closeModal(cateringCategoryModal));
cateringCategoryModal.addEventListener('click', e => { if (e.target === cateringCategoryModal) closeModal(cateringCategoryModal); });

// ─── Category Archive / Restore / Delete ───────────────────────────────────────
function openConfirmArchiveCateringCategory(categoryId) {
  const cat = allCateringCategories.find(c => c.category_id === categoryId);
  if (!cat) return;
  pendingAction = { scope: 'catering-category', type: 'archive', id: categoryId };
  confirmTitle.textContent = 'Archive Category';
  confirmCopy.textContent  = `Archive "${cat.name}"? It will disappear from the customer buffet builder until restored. Its dishes and prices are kept.`;
  confirmOk.textContent    = 'Archive';
  confirmOk.className      = 'btn-danger';
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

function openConfirmRestoreCateringCategory(categoryId) {
  const cat = allCateringCategories.find(c => c.category_id === categoryId);
  if (!cat) return;
  pendingAction = { scope: 'catering-category', type: 'restore', id: categoryId };
  confirmTitle.textContent = 'Restore Category';
  confirmCopy.textContent  = `Restore "${cat.name}" and show it in the buffet builder again?`;
  confirmOk.textContent    = 'Restore';
  confirmOk.className      = 'btn-primary';
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

// Nothing else in the schema references a catering category (reservations
// store the customer's pick as text, not a foreign key), so unlike
// package/venue delete this needs no reservation-reference check — a plain
// confirm is enough. Dishes cascade automatically (ON DELETE CASCADE).
function openConfirmDeleteCateringCategory(categoryId) {
  const cat = allCateringCategories.find(c => c.category_id === categoryId);
  if (!cat) return;
  const dishCount = dishesForCategory(categoryId).length;
  pendingDeleteAction = { scope: 'catering-category', id: categoryId, mode: 'delete' };
  deleteReassignField.classList.add('hidden');
  deleteModalTitle.textContent = 'Delete Category';
  deleteModalCopy.textContent  = `Delete "${cat.name}"${dishCount ? ` and its ${dishCount} dish${dishCount === 1 ? '' : 'es'}` : ''}? This can't be undone. Past reservations that already picked from this category keep their record — deleting it doesn't touch reservation history.`;
  deleteModalOk.textContent    = 'Delete';
  deleteModalOk.disabled = false;
  setModalMsg(deleteModalMessage, '');
  openModal(deleteModal);
}

// ─── Dish Modal (same centered position/styling as the category edit modal) ──
function openCateringDishDrawer(categoryId, triggerEl) {
  const cat = allCateringCategories.find(c => c.category_id === categoryId);
  if (!cat) return;

  cateringDishDrawerCategoryId   = categoryId;
  cateringDishDrawerCategoryName = cat.name;
  cateringDishDrawerTriggerEl    = triggerEl || document.activeElement;

  cateringDishDrawerTitle.textContent = cat.name;
  cateringNewDishInput.value = '';
  setModalMsg(cateringDishDrawerMessage, '');

  openModal(cateringDishDrawer);
  renderCateringDishDrawerList();

  const trapHandler = trapFocus(cateringDishDrawer);
  function escHandler(e) { if (e.key === 'Escape') closeCateringDishDrawer(); }
  document.addEventListener('keydown', escHandler);
  cateringDishDrawer._cleanup = () => {
    if (trapHandler) cateringDishDrawer.removeEventListener('keydown', trapHandler);
    document.removeEventListener('keydown', escHandler);
  };
}

function closeCateringDishDrawer() {
  closeModal(cateringDishDrawer);
  if (cateringDishDrawer._cleanup) { cateringDishDrawer._cleanup(); cateringDishDrawer._cleanup = null; }
  cateringDishDrawerCategoryId = null;
  cateringDishDrawerCategoryName = '';
  renderCateringTables(); // refresh dish counts on the row behind the modal
  if (cateringDishDrawerTriggerEl && document.body.contains(cateringDishDrawerTriggerEl)) cateringDishDrawerTriggerEl.focus();
  cateringDishDrawerTriggerEl = null;
}

cateringDishDrawerClose.addEventListener('click', closeCateringDishDrawer);
cateringDishDrawerDone.addEventListener('click', closeCateringDishDrawer);
cateringDishDrawer.addEventListener('click', e => { if (e.target === cateringDishDrawer) closeCateringDishDrawer(); });

function renderCateringDishDrawerList() {
  const dishes = dishesForCategory(cateringDishDrawerCategoryId);
  if (!dishes.length) {
    cateringDishDrawerList.innerHTML = '<p class="modal-hint">No dishes yet — add one below.</p>';
    return;
  }
  cateringDishDrawerList.innerHTML = dishes.map((dish, index) => `
    <div class="inclusion-row ${!dish.is_active ? 'is-archived-dish' : ''}" data-dish-id="${dish.dish_id}">
      <button type="button" class="reorder-btn" data-dish-action="up" ${index === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="reorder-btn" data-dish-action="down" ${index === dishes.length - 1 ? 'disabled' : ''}>↓</button>
      <input type="text" data-dish-name-input value="${escapeHtml(dish.name)}" placeholder="Dish name">
      <button type="button" class="dish-toggle-btn ${dish.is_active ? 'is-active' : 'is-hidden'}" data-dish-action="toggle" title="${dish.is_active ? 'Hide from customers' : 'Show to customers'}">${dish.is_active ? '●' : '○'}</button>
      <button type="button" data-dish-action="remove" title="Delete dish">✕</button>
    </div>
  `).join('');
}

async function persistDishOrder(dishes) {
  // Swap-only reorder writes just the two touched rows, not the whole list.
  await Promise.all(dishes.map(d => supabase.from(CATERING_DISH_TABLE).update({ sort_order: d.sort_order }).eq('dish_id', d.dish_id)));
}

cateringDishDrawerList.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-dish-action]');
  if (!btn) return;
  const row = btn.closest('[data-dish-id]');
  const dishId = row?.dataset.dishId;
  const dish = allCateringDishes.find(d => d.dish_id === dishId);
  if (!dish) return;
  const action = btn.dataset.dishAction;

  try {
    if (action === 'remove') {
      const { error } = await supabase.from(CATERING_DISH_TABLE).delete().eq('dish_id', dishId);
      if (error) throw error;
      allCateringDishes = allCateringDishes.filter(d => d.dish_id !== dishId);
      await logAudit({ action: 'Deleted Catering Dish', category: 'package', details: `Deleted dish: ${dish.name} (Category: ${cateringDishDrawerCategoryName})`, entityId: dishId });
      renderCateringDishDrawerList();
    }

    if (action === 'toggle') {
      const nextActive = !dish.is_active;
      const { error } = await supabase.from(CATERING_DISH_TABLE).update({ is_active: nextActive }).eq('dish_id', dishId);
      if (error) throw error;
      dish.is_active = nextActive;
      renderCateringDishDrawerList();
    }

    if (action === 'up' || action === 'down') {
      const siblings = dishesForCategory(cateringDishDrawerCategoryId);
      const idx = siblings.findIndex(d => d.dish_id === dishId);
      const swapWith = action === 'up' ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= siblings.length) return;
      const a = siblings[idx], b = siblings[swapWith];
      const tmp = a.sort_order; a.sort_order = b.sort_order; b.sort_order = tmp;
      await persistDishOrder([a, b]);
      renderCateringDishDrawerList();
    }
  } catch (err) {
    setModalMsg(cateringDishDrawerMessage, `Failed: ${err.message}`);
  }
});

cateringDishDrawerList.addEventListener('change', async (e) => {
  const input = e.target.closest('[data-dish-name-input]');
  if (!input) return;
  const row = input.closest('[data-dish-id]');
  const dishId = row?.dataset.dishId;
  const dish = allCateringDishes.find(d => d.dish_id === dishId);
  const newName = input.value.trim();
  if (!dish || !newName || newName === dish.name) { if (dish) input.value = dish.name; return; }

  try {
    const { error } = await supabase.from(CATERING_DISH_TABLE).update({ name: newName }).eq('dish_id', dishId);
    if (error) throw error;
    dish.name = newName;
  } catch (err) {
    input.value = dish.name;
    setModalMsg(cateringDishDrawerMessage, `Failed to rename: ${err.message}`);
  }
});

async function addCateringDish() {
  const name = cateringNewDishInput.value.trim();
  if (!name || !cateringDishDrawerCategoryId) return;
  cateringAddDishBtn.disabled = true;
  setModalMsg(cateringDishDrawerMessage, '');
  try {
    const siblings = dishesForCategory(cateringDishDrawerCategoryId);
    const nextSort = siblings.length ? Math.max(...siblings.map(d => d.sort_order)) + 10 : 10;
    const { data, error } = await supabase.from(CATERING_DISH_TABLE)
      .insert({ category_id: cateringDishDrawerCategoryId, name, sort_order: nextSort, is_active: true })
      .select().single();
    if (error) throw error;
    allCateringDishes.push(data);
    await logAudit({ action: 'Added Catering Dish', category: 'package', details: `New dish added: ${name} (Category: ${cateringDishDrawerCategoryName})`, entityId: data.dish_id });
    cateringNewDishInput.value = '';
    renderCateringDishDrawerList();
  } catch (err) {
    setModalMsg(cateringDishDrawerMessage, `Failed to add dish: ${err.message}`);
  } finally {
    cateringAddDishBtn.disabled = false;
    cateringNewDishInput.focus();
  }
}

cateringAddDishBtn.addEventListener('click', addCateringDish);
cateringNewDishInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCateringDish(); } });

// ═══════════════════════════════════════════════════════════════════════════════
// KEYBOARD: Escape closes modals
// ═══════════════════════════════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!categoryModal.classList.contains('hidden')) attemptCloseCategoryModal();
  if (!packageModal.classList.contains('hidden'))  attemptClosePackageModal();
  if (!tierModal.classList.contains('hidden'))     closeModal(tierModal);
  if (!confirmModal.classList.contains('hidden'))  closeModal(confirmModal);
  if (!venueModal.classList.contains('hidden'))    closeModal(venueModal);
  if (!badgeModal.classList.contains('hidden'))    closeModal(badgeModal);
  if (!badgeTypeModal.classList.contains('hidden')) closeModal(badgeTypeModal);
  if (!deleteModal.classList.contains('hidden'))   closeModal(deleteModal);
  if (!cateringCategoryModal.classList.contains('hidden')) closeModal(cateringCategoryModal);
  if (!cateringDishDrawer.classList.contains('hidden')) closeCateringDishDrawer();
});

// ═══════════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════════
function init() {
  wireLogoutButton('logoutBtn');
  watchAuthState();
  validateAdminSession({
    onSuccess: ({ profile }) => {
      if (profile.role !== 'admin') {
        window.location.replace('/admin/dashboard.html');
        return;
      }

      setupInactivityLogout(profile.role);
      initAdminSidebarBadges(supabase);
      initAdminNav({ role: profile.role });

      const avatarEl = document.getElementById('sidebarAvatar');
      if (avatarEl) avatarEl.textContent = getPortalInitials(profile);
      const roleBottomEl = document.getElementById('sidebarRoleBottom');
      if (roleBottomEl) roleBottomEl.textContent = 'Super Admin';

      // Set admin badge
      const adminBadge = document.getElementById('adminBadge');
      if (adminBadge) adminBadge.textContent = profile.role === 'admin' ? 'Admin' : 'Manager';

      // Deep link from the sidebar's Bookable Inventory > Venues sub-item
      // (admin_nav_data.js: ?view=venues).
      if (new URLSearchParams(window.location.search).get('view') === 'venues') {
        showVenueView();
      } else {
        showInventoryView();
      }
      loadInventory();
    }
  });
}

init();