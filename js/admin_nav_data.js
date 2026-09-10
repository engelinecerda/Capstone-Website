// js/admin_nav_data.js
// Single source of truth for the admin sidebar. Edit this file, not any
// individual page, to change nav structure, order, labels, or routes.
//
// Every item here is a flat, single link, deliberately — admin_nav.js has
// no expandable-group rendering at all (a `children`/dropdown grouping was
// tried for a few modules and then removed, code and all, for consistency
// across the whole sidebar rather than leaving only some modules with a
// dropdown). Several hrefs below still point at a
// page that internally supports #hash deep-linking to a specific tab or
// section (js/admin_reservation_form_config.js's tab logic for Reservation
// Form; the anchor-scroll targets in css/admin_payment_options.css for
// Payment Settings; the anchor ids on super_admin_settings.html and
// page-content.html) — that still works for anyone linking directly to a
// specific section, it's just no longer broken out into separate sidebar
// rows.
//
// Operations items are Manager-first (Manager owns operational mutations —
// see 20260714_admin_manager_separation_of_duties.sql), so their base label
// describes what Manager sees. Items whose label should read differently
// for Admin carry an `adminOverride` — applied only when role === 'admin'.
export const ADMIN_NAV = [
  {
    section: 'Operations',
    items: [
      { label: 'Dashboard',        href: '/admin/dashboard',                                        iconKey: 'layout-dashboard' },
      { label: 'Reservations',     href: '/admin/reservations',        key: 'reservations',         iconKey: 'calendar-event' },
      { label: 'Availability calendar', href: '/admin/availability-calendar', key: 'availability-calendar', iconKey: 'calendar-check' },
      { label: 'Payments',         href: '/admin/payments',                                          iconKey: 'receipt', adminOverride: { label: 'Payment records' } },
      { label: 'Contracts',        href: '/admin/contracts',                                         iconKey: 'file-text' },
      { label: 'Customers',        href: '/admin/customers',                                         iconKey: 'users' },
      { label: 'Employees',        href: '/admin/staff-roster',        key: 'staff-roster',          iconKey: 'id-badge' },
      { label: 'Reviews',          href: '/admin/reviews',                                           iconKey: 'star' },
      { label: 'Reports',          href: '/admin/reports',                                           iconKey: 'chart-bar' },
    ]
  },
  {
    section: 'Booking Configuration',
    items: [
      { label: 'Bookable Inventory',          href: '/admin/super%20admin/super_admin_packages', iconKey: 'package' },
      { label: 'Availability and scheduling', href: '/admin/super%20admin/super_admin_settings',  iconKey: 'clock' },
      { label: 'Reservation Form',            href: '/admin/config/form',                          iconKey: 'forms' },
      { label: 'Payment Settings',            href: '/admin/config/payment-options',               iconKey: 'credit-card' },
      { label: 'Notifications',               href: '/admin/config/notifications',                 iconKey: 'bell' },
    ]
  },
  {
    section: 'Website Content',
    items: [
      { label: 'Page content',      href: '/admin/system/page-content', iconKey: 'photo' },
      { label: 'Business profile',  href: '/admin/system/business',     iconKey: 'building-store' },
    ]
  },
  {
    section: 'Platform Administration',
    items: [
      { label: 'Users and roles',   href: '/admin/super%20admin/super_admin_accounts', iconKey: 'user-cog' },
      { label: 'Audit trail',       href: '/admin/super%20admin/super_admin_audit',     iconKey: 'history' },
      { label: 'Backup & Restore',  href: '/admin/super%20admin/super_admin_backup',    iconKey: 'database-backup' },
      { label: 'Announcements',     href: '/admin/maintenance/announcements',           iconKey: 'speakerphone' },
      { label: 'Maintenance Mode',  href: '/admin/maintenance/mode',                     iconKey: 'alert-triangle' },
    ]
  }
];
