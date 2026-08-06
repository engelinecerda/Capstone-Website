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
      { label: 'Dashboard',        href: '/admin/dashboard.html',                                        iconKey: 'layout-dashboard' },
      { label: 'Reservations',     href: '/admin/reservations.html',        key: 'reservations',         iconKey: 'calendar-event' },
      { label: 'Availability calendar', href: '/admin/availability-calendar.html', key: 'availability-calendar', iconKey: 'calendar-check' },
      { label: 'Payments',         href: '/admin/payments.html',                                          iconKey: 'receipt', adminOverride: { label: 'Payment records' } },
      { label: 'Contracts',        href: '/admin/contracts.html',                                         iconKey: 'file-text' },
      { label: 'Customers',        href: '/admin/customers.html',                                         iconKey: 'users' },
      { label: 'Employees',        href: '/admin/staff-roster.html',        key: 'staff-roster',          iconKey: 'id-badge' },
      { label: 'Reviews',          href: '/admin/reviews.html',                                           iconKey: 'star' },
      { label: 'Reports',          href: '/admin/reports.html',                                           iconKey: 'chart-bar' },
    ]
  },
  {
    section: 'Booking Configuration',
    items: [
      { label: 'Bookable Inventory',          href: '/admin/super%20admin/super_admin_packages.html', iconKey: 'package' },
      { label: 'Availability and scheduling', href: '/admin/super%20admin/super_admin_settings.html',  iconKey: 'clock' },
      { label: 'Reservation Form',            href: '/admin/config/form.html',                          iconKey: 'forms' },
      { label: 'Payment Settings',            href: '/admin/config/payment-options.html',               iconKey: 'credit-card' },
      { label: 'Notifications',               href: '/admin/config/notifications.html',                 iconKey: 'bell' },
    ]
  },
  {
    section: 'Website Content',
    items: [
      { label: 'Page content',      href: '/admin/system/page-content.html', iconKey: 'photo' },
      { label: 'Business profile',  href: '/admin/system/business.html',     iconKey: 'building-store' },
    ]
  },
  {
    section: 'Platform Administration',
    items: [
      { label: 'Users and roles',   href: '/admin/super%20admin/super_admin_accounts.html', iconKey: 'user-cog' },
      { label: 'Audit trail',       href: '/admin/super%20admin/super_admin_audit.html',     iconKey: 'history' },
      { label: 'Backup & Restore',  href: '/admin/super%20admin/super_admin_backup.html',    iconKey: 'database-backup' },
      { label: 'Announcements',     href: '/admin/maintenance/announcements.html',           iconKey: 'speakerphone' },
      { label: 'Maintenance Mode',  href: '/admin/maintenance/mode.html',                     iconKey: 'alert-triangle' },
    ]
  }
];
