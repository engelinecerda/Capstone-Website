// js/admin_nav_data.js
// Single source of truth for the admin sidebar. Edit this file, not any
// individual page, to change nav structure, order, labels, or routes.
//
// Several Configuration items point at the same physical page with a
// different #hash, which opens a specific tab/section there — see the
// hash-routing in js/admin_reservation_form_config.js (Reservation Form),
// the anchor scroll targets in css/admin_payment_options.css (Payment
// Options), and the matching tab logic in js/super_admin_settings.js
// (Availability and scheduling).
//
// An item with a `children` array renders as an expandable group instead of
// a direct link — see initAdminNav in admin_nav.js. Each child still needs
// its own real `href`; group items themselves are never links. Packages and
// Categories intentionally share one href — js/super_admin_packages.js
// unifies both into a single Inventory view (category rail + package grid),
// a deliberate consolidation (see 20260725_bookable_inventory.sql), so
// there's no separate "Categories" page to link to.
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
      { label: 'Reviews',          href: '/admin/reviews.html',                                           iconKey: 'star' },
      { label: 'Reports',          href: '/admin/reports.html',                                           iconKey: 'chart-bar' },
    ]
  },
  {
    section: 'Configuration',
    items: [
      {
        label: 'Bookable Inventory', iconKey: 'package',
        children: [
          { label: 'Packages',   href: '/admin/super%20admin/super_admin_packages.html' },
          { label: 'Categories', href: '/admin/super%20admin/super_admin_packages.html' },
          { label: 'Venues',     href: '/admin/super%20admin/super_admin_packages.html?view=venues' },
        ]
      },
      {
        label: 'Availability and scheduling', iconKey: 'clock',
        children: [
          { label: 'Operating Hours',               href: '/admin/super%20admin/super_admin_settings.html#hours' },
          { label: 'Booking Notice Window',          href: '/admin/super%20admin/super_admin_settings.html#notice' },
          { label: 'Per-Event-Type Notice Override', href: '/admin/super%20admin/super_admin_settings.html#notice-overrides' },
          { label: 'Buffer & Capacity',              href: '/admin/super%20admin/super_admin_settings.html#buffer-capacity' },
          { label: 'Per-Scope Capacity Override',    href: '/admin/super%20admin/super_admin_settings.html#capacity-overrides' },
        ]
      },
      {
        label: 'Reservation Form', iconKey: 'forms',
        children: [
          { label: 'Required Fields',    href: '/admin/config/form.html#required-fields' },
          { label: 'Terms & Conditions', href: '/admin/config/form.html#legal' },
          { label: 'Contract Template',  href: '/admin/config/form.html#contract-template' },
          { label: 'Event Types',        href: '/admin/config/form.html#event-types' },
        ]
      },
      {
        label: 'Payment Options', iconKey: 'credit-card',
        children: [
          { label: 'Payment Methods', href: '/admin/config/payment-options.html#payment-methods' },
          { label: 'Payment Types',   href: '/admin/config/payment-options.html#payment-types' },
          { label: 'Payment Rules',   href: '/admin/config/payment-options.html#payment-rules' },
        ]
      },
      { label: 'Notifications',                href: '/admin/config/notifications.html',                              iconKey: 'bell' },
    ]
  },
  {
    section: 'System',
    items: [
      { label: 'Users and roles',   href: '/admin/super%20admin/super_admin_accounts.html', iconKey: 'user-cog' },
      { label: 'Business profile',  href: '/admin/system/business.html',                    iconKey: 'building-store' },
      { label: 'Data export',       href: '/admin/system/export.html',                       iconKey: 'download' },
      { label: 'Audit trail',       href: '/admin/super%20admin/super_admin_audit.html',     iconKey: 'history' },
    ]
  }
];
