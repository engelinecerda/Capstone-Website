import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminNav } from './admin_nav.js';
import { getPortalInitials } from './admin_auth.js';
import { initManagerNotificationBell } from './manager_notification_bell.js';
import {
  formatDateKey,
  buildDateKey,
  getCalendarRange,
  fetchBlackoutDates,
  resolveBlackoutDateColumn,
  resolveBlackoutReasonColumn,
} from './reservation_availability.js';
import { initAutoRefresh } from './auto_refresh.js';

const calendarMonthLabel = document.getElementById('calendarMonthLabel');
const prevMonthBtn = document.getElementById('prevMonth');
const nextMonthBtn = document.getElementById('nextMonth');
const calendarGrid = document.getElementById('calendarGrid');
const calendarMessage = document.getElementById('calendarMessage');

const statOpenDays = document.getElementById('statOpenDays');
const statBookingDays = document.getElementById('statBookingDays');
const statClosedDays = document.getElementById('statClosedDays');

const dayPanelDate = document.getElementById('dayPanelDate');
const dayPanelStatusPill = document.getElementById('dayPanelStatusPill');
const dayPanelCount = document.getElementById('dayPanelCount');
const dayPanelReason = document.getElementById('dayPanelReason');
const dayPanelBookings = document.getElementById('dayPanelBookings');
const dayPanelFooter = document.getElementById('dayPanelFooter');
const dayPanelActionBtn = document.getElementById('dayPanelActionBtn');

const closedDatesMonthLabel = document.getElementById('closedDatesMonthLabel');
const closedDatesList = document.getElementById('closedDatesList');

const blackoutModal = document.getElementById('blackoutModal');
const blackoutModalClose = document.getElementById('blackoutModalClose');
const blackoutCancelBtn = document.getElementById('blackoutCancelBtn');
const blackoutConfirmBtn = document.getElementById('blackoutConfirmBtn');
const blackoutModalTitle = document.getElementById('blackoutModalTitle');
const blackoutModalCopy = document.getElementById('blackoutModalCopy');
const blackoutModalWarning = document.getElementById('blackoutModalWarning');
const blackoutModalMessage = document.getElementById('blackoutModalMessage');
const blackoutReasonInput = document.getElementById('blackoutReasonInput');

const CAPACITY_BLOCKING_STATUSES = new Set([
  'pending', 'pending_review', 'for_finalization', 'for_contract_signing',
  'approved', 'confirmed', 'partially_paid', 'fully_paid', 'rescheduled'
]);
const DEFAULT_CLOSE_REASON = 'Closed by manager';

let currentRole = null;
let adminSession = null;
let isReadOnly = false;
let currentMonth = new Date();
let reservationsCache = [];
let closedDates = new Set();
let closedDateReasons = new Map();
const blackoutColumnCache = {};
let selectedDate = null;
let pendingCloseDate = null;

/* ---------------------------------------------------------------- */
/* Formatters                                                         */
/* ---------------------------------------------------------------- */

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function formatBlackoutDate(dateIso) {
  return new Date(`${dateIso}T00:00:00`).toLocaleDateString('en-PH', {
    weekday: 'long', month: 'long', day: 'numeric'
  });
}

function formatShortMonthDay(dateIso) {
  return new Date(`${dateIso}T00:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

function formatClosedListDate(dateIso) {
  return new Date(`${dateIso}T00:00:00`).toLocaleDateString('en-US', {
    weekday: 'short', month: 'long', day: 'numeric'
  });
}

function getReservationsForDate(dateIso) {
  return reservationsCache.filter((r) => formatDateKey(r.event_date) === dateIso);
}

function getReservationEventDateTime(reservation) {
  const dateKey = formatDateKey(reservation?.event_date);
  if (!dateKey) return null;
  const eventDate = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(eventDate.getTime())) return null;
  const timeValue = String(reservation?.event_time || '').trim();
  const match = timeValue.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (match) {
    eventDate.setHours(Number(match[1]), Number(match[2]), 0, 0);
  }
  return eventDate;
}

function getEffectiveReservationStatus(reservation) {
  const normalizedStatus = String(reservation?.status || 'pending').toLowerCase();
  if (['completed', 'cancelled', 'declined'].includes(normalizedStatus)) return normalizedStatus;
  const eventDateTime = getReservationEventDateTime(reservation);
  if (eventDateTime && eventDateTime.getTime() < Date.now() && ['approved', 'confirmed', 'rescheduled'].includes(normalizedStatus)) {
    return 'completed';
  }
  if (normalizedStatus === 'confirmed') return 'approved';
  return normalizedStatus;
}

function formatStatusPill(status) {
  const key = (status || 'pending').toLowerCase();
  const label = key.split('_').filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
  return { key, label };
}

function getDayReservationCount(dateIso) {
  return reservationsCache.filter((r) =>
    formatDateKey(r.event_date) === dateIso &&
    CAPACITY_BLOCKING_STATUSES.has(String(r.status || '').toLowerCase())
  ).length;
}

function setMessage(el, msg, isError = false) {
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('error', Boolean(isError));
}

function setModalMessage(message, isError = false) {
  setMessage(blackoutModalMessage, message, isError);
}

function getBlackoutSchemaHint(error) {
  const message = error?.message || '';
  if (
    message.includes("Could not find the 'date' column of 'calendar_blackouts' in the schema cache")
    || message.includes('column calendar_blackouts.date does not exist')
  ) {
    return "calendar_blackouts exists, but Supabase cannot see a `date` column yet. Run the Step 7 SQL again, or add `date date` plus a unique index on `date`, then reload the schema cache.";
  }
  if (message.includes('row-level security policy')) {
    return "Your session is logged in, but the `calendar_blackouts` RLS policy is still denying inserts. Confirm your profile row has `role = 'manager'` or `role = 'admin'`.";
  }
  return message || 'This action could not be completed.';
}

/* ---------------------------------------------------------------- */
/* Data fetching                                                      */
/* ---------------------------------------------------------------- */

async function fetchReservationsForRange(fromDate, toDate) {
  const { data, error } = await supabase
    .from('reservations')
    .select('reservation_id, contact_name, status, event_type, event_date, event_time, guest_count')
    .gte('event_date', fromDate)
    .lte('event_date', toDate)
    .order('event_date', { ascending: true });
  if (error) throw error;
  return data || [];
}

/* ---------------------------------------------------------------- */
/* Rendering — calendar grid                                          */
/* ---------------------------------------------------------------- */

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function bindCalendarAction(cell, handler) {
  cell.setAttribute('role', 'button');
  cell.tabIndex = 0;
  cell.addEventListener('click', handler);
  cell.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handler();
    }
  });
}

function renderCalendar() {
  if (!calendarGrid) return;
  const start = startOfMonth(currentMonth);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayIso = buildDateKey(today);
  const gridStart = new Date(start);
  gridStart.setDate(start.getDate() - start.getDay());

  calendarGrid.innerHTML = '';

  for (let index = 0; index < 42; index += 1) {
    const dateObj = new Date(gridStart);
    dateObj.setDate(gridStart.getDate() + index);
    const iso = buildDateKey(dateObj);
    const isCurrentMonth = dateObj.getMonth() === currentMonth.getMonth();
    const isToday = iso === todayIso;
    const closed = closedDates.has(iso);
    const dayCount = getDayReservationCount(iso);
    const booked = dayCount > 0;
    const formattedDate = formatBlackoutDate(iso);

    const cell = document.createElement('div');
    cell.className = 'calendar-cell';

    let titleText = `${formattedDate} is open.`;

    if (!isCurrentMonth) {
      cell.classList.add('outside-month');
      titleText = `${formattedDate} is outside the current month.`;
    } else {
      if (closed) {
        cell.classList.add('closed');
        titleText = `${formattedDate} is closed.`;
      }
      if (booked) {
        titleText = `${formattedDate} has ${dayCount} reservation${dayCount !== 1 ? 's' : ''}.`;
      }
      if (isToday) cell.classList.add('today');
      if (iso === selectedDate) cell.classList.add('selected');
    }

    cell.dataset.date = iso;
    cell.title = titleText;
    cell.setAttribute('aria-label', titleText);
    cell.innerHTML = `
      <span class="calendar-day-number">${dateObj.getDate()}</span>
      ${isCurrentMonth && booked ? `<span class="calendar-day-marker"><span class="calendar-day-dot"></span>${dayCount}</span>` : ''}
    `;

    if (isCurrentMonth) {
      cell.classList.add('is-actionable');
      bindCalendarAction(cell, () => selectDate(iso));
    } else {
      cell.setAttribute('aria-disabled', 'true');
    }
    calendarGrid.appendChild(cell);
  }

  if (calendarMonthLabel) {
    calendarMonthLabel.textContent = currentMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
  }
}

function selectDate(dateIso) {
  selectedDate = dateIso;
  renderCalendar();
  renderDayPanel();
}

/* ---------------------------------------------------------------- */
/* Rendering — day detail panel                                       */
/* ---------------------------------------------------------------- */

function renderDayPanel() {
  if (!dayPanelDate || !selectedDate) return;
  const iso = selectedDate;
  const dateObj = new Date(`${iso}T00:00:00`);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const isPast = dateObj < today;
  const closed = closedDates.has(iso);

  dayPanelDate.textContent = dateObj.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric' });

  if (dayPanelStatusPill) {
    dayPanelStatusPill.textContent = closed ? 'Closed' : 'Open';
    dayPanelStatusPill.className = `status-pill ${closed ? 'day-closed' : 'day-open'}`;
  }

  const bookings = getReservationsForDate(iso);

  if (dayPanelCount) {
    dayPanelCount.textContent = bookings.length
      ? `${bookings.length} booking${bookings.length !== 1 ? 's' : ''} on this date`
      : 'No bookings on this date';
  }

  if (dayPanelReason) {
    const reason = closed ? (closedDateReasons.get(iso) || '') : '';
    if (reason) {
      dayPanelReason.textContent = `Reason: ${reason}`;
      dayPanelReason.classList.remove('hidden');
    } else {
      dayPanelReason.textContent = '';
      dayPanelReason.classList.add('hidden');
    }
  }

  if (dayPanelBookings) {
    dayPanelBookings.innerHTML = bookings.map((reservation) => {
      const status = formatStatusPill(getEffectiveReservationStatus(reservation));
      return `
        <div class="day-booking-card">
          <div class="day-booking-head">
            <span class="day-booking-name">${escapeHtml(reservation.contact_name || 'Unknown customer')}</span>
            <span class="status-pill ${escapeHtml(status.key)}">${escapeHtml(status.label)}</span>
          </div>
          <p class="day-booking-meta">${escapeHtml(reservation.event_type || 'Event')} &middot; ${escapeHtml(reservation.event_time || 'No time selected')} &middot; ${escapeHtml(String(reservation.guest_count || 0))} guests</p>
          <a href="#" class="day-booking-link" data-reservation-id="${escapeHtml(reservation.reservation_id)}">View reservation &rarr;</a>
        </div>
      `;
    }).join('');
  }

  if (dayPanelFooter && dayPanelActionBtn) {
    if (isPast || isReadOnly) {
      dayPanelFooter.hidden = true;
    } else {
      dayPanelFooter.hidden = false;
      dayPanelActionBtn.textContent = closed ? 'Reopen this date' : 'Close this date';
      dayPanelActionBtn.className = `day-panel-action ${closed ? 'action-reopen' : 'action-close'}`;
      dayPanelActionBtn.onclick = closed ? () => reopenDate(iso) : () => openBlackoutModal(iso);
    }
  }
}

/* ---------------------------------------------------------------- */
/* Rendering — month summary stats                                    */
/* ---------------------------------------------------------------- */

function renderMonthStats() {
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const totalDays = new Date(year, month + 1, 0).getDate();

  let closedCount = 0;
  let bookingDayCount = 0;

  for (let day = 1; day <= totalDays; day += 1) {
    const iso = buildDateKey(new Date(year, month, day));
    if (closedDates.has(iso)) closedCount += 1;
    if (getDayReservationCount(iso) > 0) bookingDayCount += 1;
  }

  if (statOpenDays) statOpenDays.textContent = String(totalDays - closedCount);
  if (statBookingDays) statBookingDays.textContent = String(bookingDayCount);
  if (statClosedDays) statClosedDays.textContent = String(closedCount);
}

/* ---------------------------------------------------------------- */
/* Rendering — closed dates list                                      */
/* ---------------------------------------------------------------- */

function renderClosedDatesList() {
  if (!closedDatesList) return;
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();

  if (closedDatesMonthLabel) {
    closedDatesMonthLabel.textContent = currentMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
  }

  const monthClosedDates = Array.from(closedDates)
    .filter((iso) => {
      const d = new Date(`${iso}T00:00:00`);
      return d.getFullYear() === year && d.getMonth() === month;
    })
    .sort();

  if (!monthClosedDates.length) {
    closedDatesList.innerHTML = '<p class="closed-dates-empty">No closed dates this month</p>';
    return;
  }

  closedDatesList.innerHTML = monthClosedDates.map((iso) => {
    const bookingCount = getDayReservationCount(iso);
    const subText = bookingCount > 0
      ? `${bookingCount} existing booking${bookingCount !== 1 ? 's' : ''}`
      : 'No bookings';
    const reason = closedDateReasons.get(iso) || '';
    const reopenBtn = isReadOnly ? '' : `<button type="button" class="closed-date-reopen-btn" data-date="${escapeHtml(iso)}">Reopen</button>`;
    return `
      <div class="closed-date-row" data-date="${escapeHtml(iso)}">
        <div class="closed-date-info">
          <span class="closed-date-name">${escapeHtml(formatClosedListDate(iso))}</span>
          <span class="closed-date-sub${bookingCount > 0 ? ' amber' : ''}">${escapeHtml(subText)}</span>
          ${reason ? `<span class="closed-date-reason">${escapeHtml(reason)}</span>` : ''}
        </div>
        ${reopenBtn}
      </div>
    `;
  }).join('');
}

/* ---------------------------------------------------------------- */
/* Blackout modal                                                     */
/* ---------------------------------------------------------------- */

function closeBlackoutModal() {
  pendingCloseDate = null;
  blackoutModal?.classList.add('hidden');
  blackoutModal?.setAttribute('aria-hidden', 'true');
  blackoutConfirmBtn?.removeAttribute('disabled');
  setModalMessage('');
}

function openBlackoutModal(dateIso) {
  if (isReadOnly) return;
  pendingCloseDate = dateIso;
  if (blackoutModalTitle) blackoutModalTitle.textContent = `Close ${formatShortMonthDay(dateIso)}?`;
  if (blackoutModalCopy) blackoutModalCopy.textContent = 'Customers will not be able to book this date.';

  const bookingCount = getReservationsForDate(dateIso).length;
  if (blackoutModalWarning) {
    if (bookingCount > 0) {
      blackoutModalWarning.hidden = false;
      blackoutModalWarning.textContent = `This date has ${bookingCount} reservation${bookingCount !== 1 ? 's' : ''}. Closing prevents new bookings only — existing reservations are not affected.`;
    } else {
      blackoutModalWarning.hidden = true;
      blackoutModalWarning.textContent = '';
    }
  }
  setModalMessage('');
  if (blackoutReasonInput) blackoutReasonInput.value = closedDateReasons.get(dateIso) || '';
  blackoutModal?.classList.remove('hidden');
  blackoutModal?.setAttribute('aria-hidden', 'false');
}

async function confirmCloseDate() {
  if (!pendingCloseDate || isReadOnly) return;

  blackoutConfirmBtn?.setAttribute('disabled', 'true');
  setModalMessage('Saving closed date...');

  try {
    const dateColumn = await resolveBlackoutDateColumn(supabase, blackoutColumnCache);
    if (!dateColumn) throw new Error('Unable to determine the blackout date column.');
    const reasonColumn = await resolveBlackoutReasonColumn(supabase, blackoutColumnCache);

    const enteredReason = blackoutReasonInput?.value.trim() || '';
    const payload = { [dateColumn]: pendingCloseDate, created_by: adminSession?.user?.id || null };
    if (reasonColumn) payload[reasonColumn] = enteredReason || DEFAULT_CLOSE_REASON;

    const { error } = await supabase.from('calendar_blackouts').upsert(payload, { onConflict: dateColumn });
    if (error) throw error;

    closedDates.add(pendingCloseDate);
    closedDateReasons.set(pendingCloseDate, enteredReason || DEFAULT_CLOSE_REASON);
    const closedIso = pendingCloseDate;
    closeBlackoutModal();
    afterAvailabilityChange(`Closed ${formatBlackoutDate(closedIso)}.`);
  } catch (error) {
    blackoutConfirmBtn?.removeAttribute('disabled');
    setModalMessage(getBlackoutSchemaHint(error), true);
  }
}

async function reopenDate(dateIso) {
  if (isReadOnly) return;
  try {
    const dateColumn = await resolveBlackoutDateColumn(supabase, blackoutColumnCache);
    if (!dateColumn) throw new Error('Unable to determine the blackout date column.');

    const { error } = await supabase.from('calendar_blackouts').delete().eq(dateColumn, dateIso);
    if (error) throw error;

    closedDates.delete(dateIso);
    closedDateReasons.delete(dateIso);
    afterAvailabilityChange(`Reopened ${formatBlackoutDate(dateIso)}.`);
  } catch (error) {
    setMessage(calendarMessage, `Failed to reopen date: ${getBlackoutSchemaHint(error)}`, true);
  }
}

function afterAvailabilityChange(message) {
  renderCalendar();
  renderDayPanel();
  renderMonthStats();
  renderClosedDatesList();
  setMessage(calendarMessage, message, false);
}

/* ---------------------------------------------------------------- */
/* Reservation link-out                                               */
/* ---------------------------------------------------------------- */

function goToReservationDetails(reservationId) {
  if (!reservationId) return;
  window.location.href = `/admin/reservation-details.html?id=${encodeURIComponent(reservationId)}`;
}

/* ---------------------------------------------------------------- */
/* Month loading                                                      */
/* ---------------------------------------------------------------- */

async function loadMonth({ silent = false } = {}) {
  if (!silent) {
    setMessage(calendarMessage, '');
  }

  try {
    const range = getCalendarRange(currentMonth);
    const [reservations, blackoutData] = await Promise.all([
      fetchReservationsForRange(range.fromDate, range.toDate),
      fetchBlackoutDates(supabase, blackoutColumnCache, true)
    ]);

    reservationsCache = reservations;
    closedDates = blackoutData.closedDates;
    closedDateReasons = blackoutData.closedDateReasons;

    if (!selectedDate) {
      const now = new Date();
      selectedDate = buildDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
    }

    renderCalendar();
    renderDayPanel();
    renderMonthStats();
    renderClosedDatesList();
  } catch (error) {
    if (silent) {
      console.warn('Auto-refresh failed, keeping last loaded availability data:', error.message || error);
      return;
    }
    setMessage(calendarMessage, `Failed to load availability: ${error.message || error}`, true);
  }
}

/* ---------------------------------------------------------------- */
/* Wiring                                                             */
/* ---------------------------------------------------------------- */

function wireCalendarNav() {
  prevMonthBtn?.addEventListener('click', () => {
    currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
    loadMonth();
  });
  nextMonthBtn?.addEventListener('click', () => {
    currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
    loadMonth();
  });
}

function wireBlackoutModal() {
  blackoutCancelBtn?.addEventListener('click', closeBlackoutModal);
  blackoutModalClose?.addEventListener('click', closeBlackoutModal);
  blackoutConfirmBtn?.addEventListener('click', confirmCloseDate);
  blackoutModal?.addEventListener('click', (event) => {
    if (event.target === blackoutModal) closeBlackoutModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && pendingCloseDate) closeBlackoutModal();
  });
}

function wireDayPanelBookingLinks() {
  dayPanelBookings?.addEventListener('click', (event) => {
    const link = event.target.closest('.day-booking-link');
    if (!link) return;
    event.preventDefault();
    goToReservationDetails(link.dataset.reservationId);
  });
}

function wireClosedDatesList() {
  closedDatesList?.addEventListener('click', (event) => {
    const reopenBtn = event.target.closest('.closed-date-reopen-btn');
    if (reopenBtn) {
      reopenBtn.setAttribute('disabled', 'true');
      reopenDate(reopenBtn.dataset.date).finally(() => reopenBtn.removeAttribute('disabled'));
      return;
    }
    const row = event.target.closest('.closed-date-row');
    if (!row) return;
    selectDate(row.dataset.date);
  });
}

/* ---------------------------------------------------------------- */
/* Boot                                                                */
/* ---------------------------------------------------------------- */

wireLogoutButton();
watchAuthState();
wireCalendarNav();
wireBlackoutModal();
wireDayPanelBookingLinks();
wireClosedDatesList();

initAutoRefresh(() => loadMonth({ silent: true }));

validateAdminSession({
  onSuccess: async ({ session, profile }) => {
    adminSession = session;
    currentRole = profile.role;
    isReadOnly = profile.role === 'admin';
    setupInactivityLogout(profile.role);
    const avatarEl = document.getElementById('sidebarAvatar');
    if (avatarEl) avatarEl.textContent = getPortalInitials(profile);
    const roleBottomEl = document.getElementById('sidebarRoleBottom');
    if (roleBottomEl) roleBottomEl.textContent = profile.role === 'admin' ? 'Admin' : 'Manager';
    initManagerNotificationBell(supabase, session.user.id);
    initAdminNav({ role: profile.role });
    await loadMonth();
  }
});