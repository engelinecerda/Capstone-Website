const today = new Date();
function dk(offsetDays) {
  const d = new Date(today);
  d.setDate(d.getDate() + offsetDays);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

const mockAssignments = [
  { reservation_id: 1, assigned_at: '2026-07-01', assignment_note: 'Set up the espresso bar by 1PM.' },
  { reservation_id: 2, assigned_at: '2026-07-01', assignment_note: '' },
  { reservation_id: 3, assigned_at: '2026-07-01', assignment_note: '' },
  { reservation_id: 4, assigned_at: '2026-07-01', assignment_note: 'Bring extra cups for overflow guests.' },
  { reservation_id: 5, assigned_at: '2026-07-01', assignment_note: '' },
  { reservation_id: 6, assigned_at: '2026-07-01', assignment_note: '' },
  { reservation_id: 7, assigned_at: '2026-07-01', assignment_note: '' },
  { reservation_id: 8, assigned_at: '2026-07-01', assignment_note: '' },
  { reservation_id: 9, assigned_at: '2026-07-01', assignment_note: '' }
];

const mockReservations = [
  { reservation_id: 1, contact_name: 'Maria Dela Cruz', status: 'confirmed', event_type: 'Wedding Reception', event_date: dk(-1), event_time: '02:00 PM', event_end_time: '06:00 PM', duration_hours: null, guest_count: 80, location_type: 'onsite', venue_location: null, package: { package_name: 'VIP Max', duration_hours: 4 } },
  { reservation_id: 2, contact_name: 'Juan Santos', status: 'pending', event_type: 'Birthday Party', event_date: dk(-3), event_time: '10:00 AM', event_end_time: null, duration_hours: null, guest_count: 25, location_type: 'offsite', venue_location: 'Tagaytay Garden Hall', package: { package_name: 'VIP Lite', duration_hours: 2 } },
  { reservation_id: 3, contact_name: 'Ana Reyes', status: 'completed', event_type: 'Corporate Meetup', event_date: dk(-2), event_time: '09:00 AM', event_end_time: '11:00 AM', duration_hours: null, guest_count: 40, location_type: 'onsite', venue_location: null, package: { package_name: 'VIP Plus', duration_hours: 3 } },
  { reservation_id: 4, contact_name: 'Carlos Bautista', status: 'cancelled', event_type: 'Debut', event_date: dk(-5), event_time: '04:00 PM', event_end_time: null, duration_hours: 3, guest_count: 60, location_type: 'offsite', venue_location: 'Alabang Events Place', package: { package_name: 'VIP Plus', duration_hours: 3 } },
  { reservation_id: 5, contact_name: 'Grace Villanueva', status: 'approved', event_type: 'Christening', event_date: dk(-8), event_time: '01:00 PM', event_end_time: null, duration_hours: null, guest_count: 35, location_type: 'onsite', venue_location: null, package: { package_name: 'VIP Lite', duration_hours: 2 } },
  { reservation_id: 6, contact_name: 'Peter Gonzales', status: 'confirmed', event_type: 'Anniversary', event_date: dk(-6), event_time: '05:00 PM', event_end_time: null, duration_hours: null, guest_count: 50, location_type: 'onsite', venue_location: null, package: { package_name: 'VIP Plus', duration_hours: 3 } },
  { reservation_id: 7, contact_name: 'Liza Fernandez', status: 'confirmed', event_type: 'Graduation Party', event_date: dk(-10), event_time: '11:00 AM', event_end_time: null, duration_hours: null, guest_count: 45, location_type: 'onsite', venue_location: null, package: { package_name: 'VIP Lite', duration_hours: 2 } },
  { reservation_id: 8, contact_name: 'Robert Cruz', status: 'completed', event_type: 'Baptism', event_date: dk(-12), event_time: '10:00 AM', event_end_time: null, duration_hours: null, guest_count: 30, location_type: 'onsite', venue_location: null, package: { package_name: 'VIP Lite', duration_hours: 2 } },
  { reservation_id: 9, contact_name: 'Sofia Ramos', status: 'declined', event_type: 'Team Building', event_date: dk(-1), event_time: '01:00 PM', event_end_time: null, duration_hours: null, guest_count: 20, location_type: 'offsite', venue_location: 'BGC Rooftop', package: { package_name: 'VIP Lite', duration_hours: 2 } }
];

function makeChain(result) {
  const chain = {
    select() { return chain; },
    eq() { return Promise.resolve(result); },
    in() { return Promise.resolve(result); },
    then(resolve) { return Promise.resolve(result).then(resolve); }
  };
  return chain;
}

export const portalSupabase = {
  auth: {
    onAuthStateChange() {},
    async signOut() {}
  },
  from(table) {
    if (table === 'reservation_staff_assignments') {
      return makeChain({ data: mockAssignments, error: null });
    }
    if (table === 'reservations') {
      return makeChain({ data: mockReservations, error: null });
    }
    return makeChain({ data: [], error: null });
  }
};
