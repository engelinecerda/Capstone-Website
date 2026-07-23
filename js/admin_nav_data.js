// js/admin_nav_data.js
// Single source of truth for the admin sidebar. Edit this file, not any
// individual page, to change nav structure, order, labels, or routes.
//
// Several Configuration items point at the same physical page
// (super_admin_settings.html) with a different #hash — each hash opens a
// specific tab there (see the hash-routing added in js/super_admin_settings.js).
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
      { label: 'Event types',                 href: '/admin/super%20admin/super_admin_settings.html#event-types',      iconKey: 'tags' },
      { label: 'Bookable inventory',           href: '/admin/super%20admin/super_admin_packages.html',                  iconKey: 'package' },
      { label: 'Availability and scheduling',  href: '/admin/super%20admin/super_admin_settings.html#operating-hours',  iconKey: 'clock' },
      { label: 'Reservation rules',            href: '/admin/super%20admin/super_admin_settings.html#reservation-rules', iconKey: 'adjustments' },
      { label: 'Reservation form',             href: '/admin/config/form.html',                                        iconKey: 'forms' },
      { label: 'Payment options',              href: '/admin/config/payment-options.html',                            iconKey: 'credit-card' },
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
