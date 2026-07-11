import { portalSupabase as supabase } from './zmock_supabase.js';
import { verifyPortalSession } from './zmock_admin_auth.js';

const sidebarAvatar = document.getElementById('sidebarAvatar');
const sidebarName = document.getElementById('sidebarName');
const sidebarEmail = document.getElementById('sidebarEmail');
const sidebarRolePill = document.getElementById('sidebarRolePill');
const logoutBtn = document.getElementById('logoutBtn');
const summaryTodayValue = document.getElementById('summaryTodayValue');
const summaryTodayCopy = document.getElementById('summaryTodayCopy');
const summaryWeekValue = document.getElementById('summaryWeekValue');
const summaryWeekCopy = document.getElementById('summaryWeekCopy');
const summaryNextValue = document.getElementById('summaryNextValue');
const summaryNextCopy = document.getElementById('summaryNextCopy');
const dashboardMessage = document.getElementById('dashboardMessage');
const prevMonthBtn = document.getElementById('prevMonth');
const nextMonthBtn = document.getElementById('nextMonth');
const calendarMonthLabel = document.getElementById('calendarMonthLabel');
const calendarGrid = document.getElementById('calendarGrid');
const filterRow = document.getElementById('filterRow');
const listCountCopy = document.getElementById('listCountCopy');
const activeDateFilter = document.getElementById('activeDateFilter');
const activeDateCopy = document.getElementById('activeDateCopy');
const clearDateFilterBtn = document.getElementById('clearDateFilterBtn');
const reservationList = document.getElementById('reservationList');
const reservationModal = document.getElementById('reservationModal');
const reservationModalClose = document.getElementById('reservationModalClose');
const reservationModalDismiss = document.getElementById('reservationModalDismiss');
const reservationModalHero = document.getElementById('reservationModalHero');
const reservationModalGrid = document.getElementById('reservationModalGrid');

const state = {
  profile: null,
  reservations: [],
  currentMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  activeFilter: 'today',
  selectedDate: '',
  activeReservationId: ''
};

function normalizeRole(value) {
  return String(value || '').trim().toLowerCase();
}

function redirectLogin() {
  window.location.replace('/admin/index.html');
}

function setDashboardMessage(message, isError = false) {
  if (!dashboardMessage) return;
  dashboardMessage.textContent = message;
  dashboardMessage.classList.toggle('error', isError);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function formatStaffRole(staffRole) {
  const normalized = normalizeRole(staffRole);
  if (!normalized) return 'Staff';

  return normalized
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getInitials(profile) {
  const parts = [profile?.first_name, profile?.last_name].filter(Boolean);
  const initials = parts.map((value) => value.trim().charAt(0).toUpperCase()).join('');
  return initials || String(profile?.email || 'S').charAt(0).toUpperCase();
}

function getDisplayName(profile) {
  const parts = [
    profile?.first_name,
    profile?.middle_name,
    profile?.last_name
  ].filter(Boolean);

  return parts.join(' ') || profile?.email || 'Staff member';
}

function formatDateKey(value) {
  return String(value || '').split('T')[0];
}

function getTodayKey() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');
}

function parseDateKey(dateKey) {
  if (!dateKey) return null;
  const date = new Date(`${dateKey}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = parseDateKey(formatDateKey(value)) || new Date(value);
  if (Number.isNaN(date.getTime())) return 'No date';
  return date.toLocaleDateString('en-PH', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function formatShortDate(value) {
  const date = parseDateKey(formatDateKey(value)) || new Date(value);
  if (Number.isNaN(date.getTime())) return 'No date';
  return date.toLocaleDateString('en-PH', {
    month: 'short',
    day: 'numeric'
  });
}

function formatMonthLabel(date) {
  return date.toLocaleDateString('en-PH', {
    month: 'long',
    year: 'numeric'
  });
}

function getReservationDateKey(reservation) {
  return formatDateKey(reservation?.event_date);
}

function isToday(dateKey) {
  return dateKey === getTodayKey();
}

function isInThisWeek(dateKey) {
  const date = parseDateKey(dateKey);
  if (!date) return false;

  const today = parseDateKey(getTodayKey());
  const weekEnd = new Date(today);
  weekEnd.setDate(today.getDate() + 6);
  return date >= today && date <= weekEnd;
}

function isUpcoming(dateKey) {
  const date = parseDateKey(dateKey);
  const today = parseDateKey(getTodayKey());
  if (!date || !today) return false;
  return date >= today;
}

function isPast(dateKey) {
  const date = parseDateKey(dateKey);
  const today = parseDateKey(getTodayKey());
  if (!date || !today) return false;
  return date < today;
}

const FILTER_LABELS = {
  today: 'today',
  week: 'this week',
  upcoming: 'upcoming',
  past: 'past'
};

function getReservationStatusMeta(status) {
  const normalized = normalizeRole(status);
  if (normalized === 'completed') {
    return { key: 'completed', label: 'Completed' };
  }
  if (normalized === 'cancelled' || normalized === 'declined') {
    return { key: 'cancelled', label: 'Cancelled' };
  }
  if (['approved', 'confirmed', 'partially_paid', 'fully_paid', 'rescheduled'].includes(normalized)) {
    return { key: 'approved', label: 'Confirmed' };
  }
  return { key: 'pending', label: 'Pending' };
}

function getCustomerSurname(reservation) {
  const parts = String(reservation?.contact_name || '').trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'Customer';
}

function getReservationDurationHours(reservation) {
  const storedDuration = Number(reservation?.duration_hours || 0);
  if (storedDuration > 0) return storedDuration;

  const packageDuration = Number(reservation?.package?.duration_hours || 0);
  if (packageDuration > 0) return packageDuration;

  return 2;
}

function formatMinutesAsLabel(minutes) {
  if (minutes == null) return '';
  let hours = Math.floor(minutes / 60);
  const mins = String(minutes % 60).padStart(2, '0');
  const suffix = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${hours}:${mins} ${suffix}`;
}

function getReservationTimeRangeLabel(reservation) {
  const start = parseTimeValue(reservation?.event_time);
  if (!start) return reservation?.event_time || 'No time selected';

  const startMinutes = start.hours * 60 + start.minutes;
  const end = parseTimeValue(reservation?.event_end_time);
  const endMinutes = end
    ? end.hours * 60 + end.minutes
    : startMinutes + getReservationDurationHours(reservation) * 60;

  return `${formatMinutesAsLabel(startMinutes)}–${formatMinutesAsLabel(endMinutes)}`;
}

function getLocationLabel(reservation) {
  return normalizeRole(reservation?.location_type) === 'onsite'
    ? 'On-site - ELI Coffee'
    : reservation?.venue_location || 'Customer venue';
}

function getEventTitle(reservation) {
  return reservation?.event_type || reservation?.package?.package_name || 'Assigned Reservation';
}

function getAssignmentNote(reservation) {
  return String(reservation?.assignment_note || '').trim();
}

function parseTimeValue(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3].toUpperCase();

  if (hours === 12) {
    hours = meridiem === 'AM' ? 0 : 12;
  } else if (meridiem === 'PM') {
    hours += 12;
  }

  return { hours, minutes };
}

function getSortValue(reservation) {
  const dateKey = getReservationDateKey(reservation);
  const date = parseDateKey(dateKey);
  if (!date) return Number.MAX_SAFE_INTEGER;

  const timeParts = parseTimeValue(reservation?.event_time);
  if (timeParts) {
    date.setHours(timeParts.hours, timeParts.minutes, 0, 0);
  }

  return date.getTime();
}

function sortReservations(list) {
  return [...list].sort((left, right) => getSortValue(left) - getSortValue(right));
}

function getAssignmentsForCurrentFilter() {
  let list = state.reservations;

  if (state.selectedDate) {
    return sortReservations(list.filter((reservation) => getReservationDateKey(reservation) === state.selectedDate));
  }

  if (state.activeFilter === 'today') {
    list = list.filter((reservation) => isToday(getReservationDateKey(reservation)));
  } else if (state.activeFilter === 'week') {
    list = list.filter((reservation) => isInThisWeek(getReservationDateKey(reservation)));
  } else if (state.activeFilter === 'past') {
    return sortReservations(list.filter((reservation) => isPast(getReservationDateKey(reservation)))).reverse();
  } else {
    list = list.filter((reservation) => isUpcoming(getReservationDateKey(reservation)));
  }

  return sortReservations(list);
}

function syncFilterButtons() {
  filterRow?.querySelectorAll('.filter-chip').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === state.activeFilter);
  });
}

function updateActiveDateBanner() {
  const hasSelectedDate = Boolean(state.selectedDate);
  activeDateFilter?.classList.toggle('hidden', !hasSelectedDate);
  if (hasSelectedDate && activeDateCopy) {
    activeDateCopy.textContent = `Showing assignments for ${formatDate(state.selectedDate)}`;
  }
}

function renderSummary() {
  const todayCount = state.reservations.filter((reservation) => isToday(getReservationDateKey(reservation))).length;
  const weekCount = state.reservations.filter((reservation) => isInThisWeek(getReservationDateKey(reservation))).length;
  const roleLabel = formatStaffRole(state.profile?.staff_role);
  const today = parseDateKey(getTodayKey());
  const weekEnd = new Date(today);
  weekEnd.setDate(today.getDate() + 6);

  if (summaryTodayValue) summaryTodayValue.textContent = String(todayCount);
  if (summaryTodayCopy) {
    summaryTodayCopy.textContent = todayCount
      ? `${todayCount} event${todayCount === 1 ? '' : 's'} scheduled`
      : 'No assignments today';
  }

  if (summaryWeekValue) summaryWeekValue.textContent = String(weekCount);
  if (summaryWeekCopy) {
    summaryWeekCopy.textContent = `${formatShortDate(today)} – ${formatShortDate(weekEnd)}`;
  }

  const nextAssignment = sortReservations(
    state.reservations.filter((reservation) => isUpcoming(getReservationDateKey(reservation)))
  )[0] || null;

  if (summaryNextValue) {
    summaryNextValue.textContent = nextAssignment
      ? `Next up · ${getEventTitle(nextAssignment)}`
      : 'Next up · None scheduled';
  }
  if (summaryNextCopy) {
    summaryNextCopy.textContent = nextAssignment
      ? `${formatShortDate(nextAssignment.event_date)} · ${nextAssignment.event_time || 'No time selected'}`
      : '';
  }

  if (sidebarRolePill) sidebarRolePill.textContent = roleLabel;
}

function renderProfileShell() {
  if (sidebarAvatar) sidebarAvatar.textContent = getInitials(state.profile);
  if (sidebarName) sidebarName.textContent = getDisplayName(state.profile);
  if (sidebarEmail) sidebarEmail.textContent = state.profile?.email || 'No email on file';
}

function renderCalendar() {
  if (!calendarGrid) return;

  const currentMonth = state.currentMonth;
  const monthStart = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
  const gridStart = new Date(monthStart);
  gridStart.setDate(monthStart.getDate() - monthStart.getDay());
  const assignedDateSet = new Set(state.reservations.map((reservation) => getReservationDateKey(reservation)).filter(Boolean));
  const todayKey = getTodayKey();

  calendarGrid.innerHTML = '';
  if (calendarMonthLabel) {
    calendarMonthLabel.textContent = formatMonthLabel(currentMonth);
  }

  for (let index = 0; index < 42; index += 1) {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const dateKey = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    ].join('-');
    const isCurrentMonth = date.getMonth() === currentMonth.getMonth();
    const isAssigned = assignedDateSet.has(dateKey);
    const cell = document.createElement('button');

    cell.type = 'button';
    cell.className = 'calendar-cell';
    if (!isCurrentMonth) cell.classList.add('outside');
    if (dateKey === todayKey) cell.classList.add('today');
    if (isAssigned) cell.classList.add('assigned');
    if (dateKey === state.selectedDate) cell.classList.add('selected');
    if (!isAssigned) {
      cell.disabled = true;
    }

    cell.innerHTML = `<span class="cell-day">${date.getDate()}</span>${isAssigned ? '<span class="cell-dot"></span>' : ''}`;
    cell.setAttribute('aria-label', isAssigned
      ? `${formatDate(dateKey)} has an assigned reservation`
      : `${formatDate(dateKey)} has no assignment`);

    if (isAssigned) {
      cell.addEventListener('click', () => {
        state.selectedDate = dateKey;
        renderCalendar();
        renderReservations();
      });
    }

    calendarGrid.appendChild(cell);
  }
}

function renderReservations() {
  if (!reservationList) return;

  syncFilterButtons();
  updateActiveDateBanner();
  const filtered = getAssignmentsForCurrentFilter();
  const total = state.reservations.length;
  const pastCount = state.reservations.filter((reservation) => isPast(getReservationDateKey(reservation))).length;

  if (listCountCopy) {
    listCountCopy.textContent = state.selectedDate
      ? `Showing ${filtered.length} for ${formatShortDate(state.selectedDate)} of ${total} total`
      : `Showing ${filtered.length} ${FILTER_LABELS[state.activeFilter] || 'upcoming'} of ${total} total`;
  }

  if (!filtered.length) {
    const emptyLead = state.selectedDate
      ? `No assignments were found for ${formatDate(state.selectedDate)}.`
      : state.activeFilter === 'today'
        ? 'No assignments are scheduled for today.'
        : state.activeFilter === 'week'
          ? 'No assignments are scheduled this week.'
          : state.activeFilter === 'past'
            ? 'No past assignments yet.'
            : 'No upcoming assignments.';

    const showHistoryLink = !state.selectedDate && state.activeFilter !== 'past' && pastCount > 0;

    reservationList.innerHTML = `
      <div class="empty-state">
        <h3 class="empty-state-title">No assigned reservations</h3>
        <p class="empty-state-copy">
          ${escapeHtml(emptyLead)}
          ${showHistoryLink ? ` You have ${pastCount} past assignment${pastCount === 1 ? '' : 's'} — <button type="button" class="text-btn" id="viewHistoryBtn">view history</button>` : ''}
        </p>
      </div>
    `;
    return;
  }

  reservationList.innerHTML = filtered.map((reservation) => {
    const status = getReservationStatusMeta(reservation.status);
    const note = getAssignmentNote(reservation);

    return `
      <article class="reservation-card">
        <div class="reservation-card-head">
          <h3 class="reservation-title">${escapeHtml(getEventTitle(reservation))} — ${escapeHtml(getCustomerSurname(reservation))}</h3>
          <span class="status-badge ${escapeHtml(status.key)}">${escapeHtml(status.label)}</span>
        </div>
        <p class="reservation-line2">${escapeHtml(formatShortDate(reservation.event_date))} · ${escapeHtml(getReservationTimeRangeLabel(reservation))} · ${escapeHtml(getLocationLabel(reservation))}</p>
        <p class="reservation-line3">${escapeHtml(String(reservation.guest_count || 0))} guests${note ? ` · ${escapeHtml(note)}` : ''}</p>
        <div class="reservation-actions">
          <button type="button" class="primary-btn" data-action="view-details" data-reservation-id="${reservation.reservation_id}">View Details</button>
        </div>
      </article>
    `;
  }).join('');
}

function getReservationById(reservationId) {
  return state.reservations.find((reservation) => String(reservation.reservation_id) === String(reservationId)) || null;
}

function buildModalCard(label, value, full = false) {
  return `
    <div class="modal-detail-card${full ? ' full' : ''}">
      <span class="modal-detail-label">${escapeHtml(label)}</span>
      <div class="modal-detail-value">${escapeHtml(value)}</div>
    </div>
  `;
}

function renderReservationModal(reservationId) {
  const reservation = getReservationById(reservationId);
  if (!reservation) return;

  const status = getReservationStatusMeta(reservation.status);
  state.activeReservationId = reservationId;

  reservationModalHero.innerHTML = `
    <div class="reservation-card-head">
      <div>
        <h3 class="modal-hero-title">${escapeHtml(getEventTitle(reservation))}</h3>
        <p class="modal-hero-copy">${escapeHtml(reservation.contact_name || 'Assigned customer')} | ${escapeHtml(formatStaffRole(state.profile?.staff_role))}</p>
      </div>
      <span class="status-badge ${escapeHtml(status.key)}">${escapeHtml(status.label)}</span>
    </div>
  `;

  reservationModalGrid.innerHTML = [
    buildModalCard('Customer', reservation.contact_name || 'Assigned customer'),
    buildModalCard('Your Role', formatStaffRole(state.profile?.staff_role)),
    buildModalCard('Date', formatDate(reservation.event_date)),
    buildModalCard('Time', reservation.event_time || 'No time selected'),
    buildModalCard('Location', getLocationLabel(reservation), true),
    buildModalCard('Package', reservation.package?.package_name || 'Package pending'),
    buildModalCard('Guests', `${String(reservation.guest_count || 0)} pax`),
    buildModalCard('Reservation Status', status.label),
    buildModalCard('Event Type', reservation.event_type || 'Reserved event', true),
    ...(getAssignmentNote(reservation)
      ? [buildModalCard('Assigned Note', getAssignmentNote(reservation), true)]
      : [])
  ].join('');

  reservationModal.classList.remove('hidden');
  reservationModal.setAttribute('aria-hidden', 'false');
}

function closeReservationModal() {
  state.activeReservationId = '';
  reservationModal.classList.add('hidden');
  reservationModal.setAttribute('aria-hidden', 'true');
}

function getAssignmentsErrorHint(error) {
  const message = error?.message || '';
  if (message.toLowerCase().includes('row-level security')) {
    return 'Your session is valid, but Supabase still needs a reservation read policy for assigned staff. Run the staff dashboard policy SQL first.';
  }
  return message || 'Unable to load assigned reservations right now.';
}

async function fetchAssignedReservations(userId) {
  let assignmentResponse = await supabase
    .from('reservation_staff_assignments')
    .select('reservation_id, assigned_at, assignment_note')
    .eq('staff_user_id', userId);

  if (
    assignmentResponse.error
    && (
      String(assignmentResponse.error.message || '').includes("Could not find the 'assignment_note' column")
      || String(assignmentResponse.error.message || '').includes('column reservation_staff_assignments.assignment_note does not exist')
    )
  ) {
    assignmentResponse = await supabase
      .from('reservation_staff_assignments')
      .select('reservation_id, assigned_at')
      .eq('staff_user_id', userId);
  }

  const { data: assignments, error: assignmentError } = assignmentResponse;

  if (assignmentError) throw assignmentError;

  const assignmentMetaByReservationId = (assignments || []).reduce((map, assignment) => {
    map[assignment.reservation_id] = {
      assigned_at: assignment.assigned_at || null,
      assignment_note: assignment.assignment_note || ''
    };
    return map;
  }, {});

  const reservationIds = (assignments || []).map((assignment) => assignment.reservation_id).filter(Boolean);
  if (!reservationIds.length) return [];

  const { data: reservations, error: reservationError } = await supabase
    .from('reservations')
    .select(`
      reservation_id,
      contact_name,
      status,
      event_type,
      event_date,
      event_time,
      event_end_time,
      duration_hours,
      guest_count,
      location_type,
      venue_location,
      created_at,
      package:package_id (
        package_name,
        duration_hours
      )
    `)
    .in('reservation_id', reservationIds);

  if (reservationError) throw reservationError;
  return sortReservations((reservations || []).map((reservation) => ({
    ...reservation,
    assigned_at: assignmentMetaByReservationId[reservation.reservation_id]?.assigned_at || null,
    assignment_note: assignmentMetaByReservationId[reservation.reservation_id]?.assignment_note || ''
  })));
}

function determineInitialFilter() {
  const hasTodayAssignments = state.reservations.some((reservation) => isToday(getReservationDateKey(reservation)));
  state.activeFilter = hasTodayAssignments ? 'today' : 'upcoming';
}

async function loadDashboard() {
  setDashboardMessage('Loading your assignments...');

  try {
    const { session, profile, message } = await verifyPortalSession(supabase, { requiredRole: 'staff' });
    if (!session) {
      await supabase.auth.signOut();
      redirectLogin();
      return;
    }

    state.profile = profile;
    renderProfileShell();
    renderSummary();

    state.reservations = await fetchAssignedReservations(session.user.id);
    determineInitialFilter();
    renderSummary();
    renderCalendar();
    renderReservations();

    const totalAssignments = state.reservations.length;
    setDashboardMessage(
      totalAssignments
        ? `Showing ${totalAssignments} assigned reservation${totalAssignments === 1 ? '' : 's'} in your schedule.`
        : 'You do not have any assigned reservations yet.'
    );
  } catch (error) {
    state.reservations = [];
    renderCalendar();
    renderReservations();
    setDashboardMessage(getAssignmentsErrorHint(error), true);
  }
}

function bindEvents() {
  logoutBtn?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    redirectLogin();
  });

  prevMonthBtn?.addEventListener('click', () => {
    state.currentMonth = new Date(state.currentMonth.getFullYear(), state.currentMonth.getMonth() - 1, 1);
    renderCalendar();
  });

  nextMonthBtn?.addEventListener('click', () => {
    state.currentMonth = new Date(state.currentMonth.getFullYear(), state.currentMonth.getMonth() + 1, 1);
    renderCalendar();
  });

  filterRow?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.activeFilter = button.dataset.filter || 'today';
    state.selectedDate = '';
    renderCalendar();
    renderReservations();
  });

  clearDateFilterBtn?.addEventListener('click', () => {
    state.selectedDate = '';
    renderCalendar();
    renderReservations();
  });

  reservationList?.addEventListener('click', (event) => {
    if (event.target.closest('#viewHistoryBtn')) {
      state.activeFilter = 'past';
      state.selectedDate = '';
      renderCalendar();
      renderReservations();
      return;
    }

    const button = event.target.closest('[data-action="view-details"]');
    if (!button) return;
    renderReservationModal(button.dataset.reservationId);
  });

  reservationModalClose?.addEventListener('click', closeReservationModal);
  reservationModalDismiss?.addEventListener('click', closeReservationModal);
  reservationModal?.addEventListener('click', (event) => {
    if (event.target === reservationModal) closeReservationModal();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.activeReservationId) {
      closeReservationModal();
    }
  });

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') redirectLogin();
  });
}

bindEvents();
await loadDashboard();
