import { portalSupabase as supabase } from './supabase.js';
import { verifyPortalSession } from './admin_auth.js';

const boardClock = document.getElementById('boardClock');
const boardDate = document.getElementById('boardDate');
const boardPanelTitle = document.getElementById('boardPanelTitle');
const boardTodaySub = document.getElementById('boardTodaySub');
const boardTodayList = document.getElementById('boardTodayList');
const boardWeekDays = document.getElementById('boardWeekDays');
const boardFooterMessage = document.getElementById('boardFooterMessage');
const boardStatusDot = document.getElementById('boardStatusDot');
const boardShell = document.getElementById('boardShell');
const boardSignedOutState = document.getElementById('boardSignedOutState');
const boardLogoutBtn = document.getElementById('boardLogoutBtn');
const boardBrowsingBanner = document.getElementById('boardBrowsingBanner');
const boardBrowsingBannerText = document.getElementById('boardBrowsingBannerText');
const boardBackToTodayBtn = document.getElementById('boardBackToTodayBtn');
const boardLogoutConfirmOverlay = document.getElementById('boardLogoutConfirmOverlay');
const boardLogoutCancelBtn = document.getElementById('boardLogoutCancelBtn');
const boardLogoutConfirmBtn = document.getElementById('boardLogoutConfirmBtn');

const IDLE_RETURN_MS = 40000;
const RECENTLY_UPDATED_MS = 4 * 60 * 60 * 1000;

const state = {
  days: [],
  lastUpdatedAt: null,
  connectionLost: false,
  selectedDate: null,
  idleTimer: null,
  kioskMode: false,
  wakeLockSentinel: null
};

const STATUS_META = {
  approved: { key: 'approved', label: 'Confirmed' },
  confirmed: { key: 'approved', label: 'Confirmed' },
  partially_paid: { key: 'approved', label: 'Confirmed' },
  fully_paid: { key: 'approved', label: 'Confirmed' },
  rescheduled: { key: 'approved', label: 'Confirmed' },
  completed: { key: 'completed', label: 'Completed' },
  cancelled: { key: 'cancelled', label: 'Cancelled' }
};

function getStatusMeta(status) {
  const normalized = String(status || '').trim().toLowerCase();
  return STATUS_META[normalized] || { key: 'pending', label: 'Scheduled' };
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

function getTodayKey() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');
}

function formatDateKey(value) {
  return String(value || '').split('T')[0];
}

function parseDateKey(dateKey) {
  if (!dateKey) return null;
  const date = new Date(`${dateKey}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDaysKey(dateKey, days) {
  const date = parseDateKey(dateKey);
  date.setDate(date.getDate() + days);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function formatDayLabel(dateKey, isToday) {
  const date = parseDateKey(dateKey);
  const weekday = date.toLocaleDateString('en-PH', { weekday: 'short' });
  const monthDay = date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
  return isToday ? `Today · ${monthDay}` : `${weekday} · ${monthDay}`;
}

function formatFullDayHeading(dateKey) {
  const today = getTodayKey();
  const date = parseDateKey(dateKey);
  const weekday = date.toLocaleDateString('en-PH', { weekday: 'long' });
  const monthDay = date.toLocaleDateString('en-PH', { month: 'long', day: 'numeric' });

  if (dateKey === today) return `Today · ${weekday}, ${monthDay}`;

  const diffDays = Math.round((date.getTime() - parseDateKey(today).getTime()) / 86400000);
  const relative = diffDays === 1 ? '1 day from now' : `${diffDays} days from now`;
  return `${weekday}, ${monthDay} · ${relative}`;
}

function isRecentlyUpdated(event, now) {
  if (!event.updated_at) return false;
  const updatedAt = new Date(event.updated_at);
  if (Number.isNaN(updatedAt.getTime())) return false;
  return (now.getTime() - updatedAt.getTime()) < RECENTLY_UPDATED_MS && now.getTime() >= updatedAt.getTime();
}

function parseTimeValue(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3].toUpperCase();
  if (hours === 12) hours = meridiem === 'AM' ? 0 : 12;
  else if (meridiem === 'PM') hours += 12;
  return { hours, minutes };
}

function getEventStartDate(event) {
  const date = parseDateKey(formatDateKey(event.event_date));
  if (!date) return null;
  const time = parseTimeValue(event.event_time);
  if (time) date.setHours(time.hours, time.minutes, 0, 0);
  return date;
}

function getEventEndDate(event) {
  const start = getEventStartDate(event);
  if (!start) return null;
  const endTime = parseTimeValue(event.event_end_time);
  if (endTime) {
    const end = new Date(start);
    end.setHours(endTime.hours, endTime.minutes, 0, 0);
    return end;
  }
  const durationHours = Number(event.duration_hours) > 0 ? Number(event.duration_hours) : 2;
  return new Date(start.getTime() + durationHours * 60 * 60 * 1000);
}

function getLocationLabel(event) {
  return String(event.location_type || '').toLowerCase() === 'onsite'
    ? 'On-site - ELI Coffee'
    : event.venue_location || 'Customer venue';
}

function getStaffChipsHtml(event) {
  if (!event.staff_names || !event.staff_names.length) {
    return '<span class="board-staff-chip-outline">Staff TBA</span>';
  }
  return event.staff_names.map((name) => {
    const initial = String(name || '?').trim().charAt(0).toUpperCase() || '?';
    return `<span class="board-staff-chip"><span class="board-staff-avatar">${escapeHtml(initial)}</span>${escapeHtml(name)}</span>`;
  }).join('');
}

function computeEventFlag(event, now) {
  const start = getEventStartDate(event);
  const end = getEventEndDate(event);
  if (!start || !end) return null;
  if (now >= start && now <= end) return { key: 'now', label: 'Happening now', diffMinutes: 0 };
  if (now < start) {
    const diffMinutes = Math.round((start.getTime() - now.getTime()) / 60000);
    const hours = Math.floor(diffMinutes / 60);
    const minutes = diffMinutes % 60;
    const parts = [];
    if (hours) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);
    return { key: 'next', label: `in ${parts.join(' ')}`, diffMinutes };
  }
  return null;
}

const IMMINENT_WINDOW_MINUTES = 60;

// Proximity carries "when" (Starting soon / Later today / Completed), not a
// restated status — a plain status pill ("Confirmed") told staff nothing they
// didn't already know from the event being on the board at all.
function getProximityMeta(event, now, isViewingToday) {
  const status = getStatusMeta(event.status);
  if (status.key === 'cancelled') return { key: 'cancelled', label: 'Cancelled' };
  if (status.key === 'completed') return { key: 'completed', label: 'Completed' };
  if (!isViewingToday) return null;

  const flag = computeEventFlag(event, now);
  if (!flag) return { key: 'later', label: 'Later today' };
  if (flag.key === 'now') return { key: 'now', label: 'Happening now' };
  if (flag.diffMinutes <= IMMINENT_WINDOW_MINUTES) {
    return { key: 'imminent', label: `Starting soon · ${flag.label}` };
  }
  return { key: 'later', label: 'Later today' };
}

function renderClock() {
  const now = new Date();
  boardClock.textContent = now.toLocaleTimeString('en-PH', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  });
  boardDate.textContent = now.toLocaleDateString('en-PH', {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  });
}

function renderEventCard(event, now, isViewingToday) {
  const status = getStatusMeta(event.status);
  const proximity = getProximityMeta(event, now, isViewingToday);
  const isImminentCard = Boolean(proximity && (proximity.key === 'now' || proximity.key === 'imminent'));

  const startTime = getEventStartDate(event);
  const endTime = getEventEndDate(event);
  const timeLabel = startTime && endTime
    ? `${startTime.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })} – ${endTime.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })}`
    : (event.event_time || 'Time TBD');

  const stateClasses = [
    isImminentCard ? 'board-event-imminent' : '',
    status.key === 'completed' ? 'board-event-completed' : '',
    status.key === 'cancelled' ? 'board-event-cancelled' : ''
  ].filter(Boolean).join(' ');

  const proximityPillHtml = proximity
    ? `<span class="board-proximity-pill board-proximity-${proximity.key}">${escapeHtml(proximity.label)}</span>`
    : '';

  const updateBadgeHtml = status.key !== 'cancelled' && isRecentlyUpdated(event, now)
    ? `<span class="board-update-badge"><i class="fa-solid fa-pen"></i> Updated ${escapeHtml(new Date(event.updated_at).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' }))}</span>`
    : '';

  return `
    <article class="board-event-card${stateClasses ? ' ' + stateClasses : ''}">
      <div class="board-event-card-head">
        <h3 class="board-event-heading">
          <span class="board-event-time-inline">${escapeHtml(timeLabel)}</span>
          <span class="board-event-sep">·</span>
          <span class="board-event-name-inline">${escapeHtml(event.event_type || 'Reserved Event')}</span>
        </h3>
        <div class="board-event-badges">
          ${proximityPillHtml}
          ${updateBadgeHtml}
        </div>
      </div>
      <p class="board-event-meta">${escapeHtml(event.package_name || 'Package pending')} · ${escapeHtml(String(event.guest_count || 0))} guests · ${escapeHtml(getLocationLabel(event))}</p>
      <div class="board-staff-chips">${getStaffChipsHtml(event)}</div>
      ${event.manager_notes ? `<p class="board-event-notes"><i class="fa-solid fa-note-sticky"></i> ${escapeHtml(event.manager_notes)}</p>` : ''}
    </article>
  `;
}

function render() {
  const now = new Date();
  const todayKey = getTodayKey();
  if (!state.selectedDate) state.selectedDate = todayKey;
  const isViewingToday = state.selectedDate === todayKey;

  const todayEntry = state.days.find((day) => day.date === todayKey);
  const viewedEntry = state.days.find((day) => day.date === state.selectedDate) || todayEntry;
  const viewedEvents = viewedEntry?.events || [];

  boardPanelTitle.textContent = formatFullDayHeading(state.selectedDate);
  boardTodaySub.textContent = viewedEvents.length
    ? `${viewedEvents.length} event${viewedEvents.length === 1 ? '' : 's'} scheduled`
    : 'No events scheduled';

  if (boardBrowsingBanner) {
    boardBrowsingBanner.classList.toggle('hidden', isViewingToday);
    if (!isViewingToday && boardBrowsingBannerText) {
      boardBrowsingBannerText.textContent = `Viewing ${formatDayLabel(state.selectedDate, false)} · this view returns to Today automatically`;
    }
  }

  boardTodayList.innerHTML = viewedEvents.length
    ? viewedEvents.map((event) => renderEventCard(event, now, isViewingToday)).join('')
    : '<div class="board-empty-day"><i class="fa-solid fa-mug-hot"></i><p>No events scheduled</p></div>';

  const daysWithEvents = state.days.filter((day) => day.events.length > 0);
  boardWeekDays.innerHTML = daysWithEvents.map((day) => {
    const isToday = day.date === todayKey;
    const isSelected = day.date === state.selectedDate;
    const eventsHtml = day.events.map((event) => `
        <div class="board-week-event">
          <span class="board-week-event-time">${escapeHtml(event.event_time || '')}</span>
          <span class="board-week-event-name">${escapeHtml(event.event_type || 'Reserved Event')}</span>
        </div>
      `).join('');

    return `
      <button type="button" class="board-week-row${isToday ? ' board-week-row-today' : ''}${isSelected ? ' board-week-row-selected' : ''}" data-date="${escapeHtml(day.date)}">
        <div class="board-week-row-main">
          <div class="board-week-row-head">
            <p class="board-week-row-label">${escapeHtml(formatDayLabel(day.date, isToday))}</p>
            ${isSelected ? '<span class="board-week-row-viewing">Viewing</span>' : ''}
          </div>
          <div class="board-week-row-events">${eventsHtml}</div>
        </div>
        <i class="fa-solid fa-chevron-right board-week-row-chevron"></i>
      </button>
    `;
  }).join('');
}

function renderFooter() {
  if (state.connectionLost) {
    boardFooterMessage.textContent = 'Connection lost — retrying';
    boardStatusDot.classList.add('board-status-dot-lost');
    return;
  }
  boardStatusDot.classList.remove('board-status-dot-lost');
  const timeLabel = state.lastUpdatedAt
    ? state.lastUpdatedAt.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })
    : '--:--';
  boardFooterMessage.textContent = `Updated ${timeLabel} · refreshes every 60 seconds`;
}

async function fetchSchedule() {
  const todayKey = getTodayKey();
  const weekEndKey = addDaysKey(todayKey, 6);

  const { data: reservations, error: reservationsError } = await supabase
    .from('board_reservations_view')
    .select(`
      reservation_id,
      event_type,
      event_date,
      event_time,
      event_end_time,
      duration_hours,
      guest_count,
      location_type,
      venue_location,
      status,
      package_id,
      updated_at,
      package:package_id ( package_name )
    `)
    .gte('event_date', todayKey)
    .lte('event_date', weekEndKey);

  if (reservationsError) throw reservationsError;

  const reservationIds = (reservations || []).map((r) => r.reservation_id);
  let assignmentsByReservationId = {};

  if (reservationIds.length) {
    const { data: assignments, error: assignmentsError } = await supabase
      .from('reservation_staff_assignments')
      .select('reservation_id, assignment_note, roster_staff_id, staff_roster:roster_staff_id ( first_name, is_active )')
      .in('reservation_id', reservationIds);

    if (assignmentsError) throw assignmentsError;

    assignmentsByReservationId = (assignments || []).reduce((map, row) => {
      if (!map[row.reservation_id]) map[row.reservation_id] = { names: [], note: '' };
      if (row.staff_roster?.is_active && row.staff_roster?.first_name) {
        map[row.reservation_id].names.push(row.staff_roster.first_name);
      }
      if (row.assignment_note) map[row.reservation_id].note = row.assignment_note;
      return map;
    }, {});
  }

  const dayBuckets = {};
  for (let i = 0; i <= 6; i += 1) {
    const key = addDaysKey(todayKey, i);
    dayBuckets[key] = [];
  }

  (reservations || []).forEach((reservation) => {
    const dateKey = formatDateKey(reservation.event_date);
    if (!dayBuckets[dateKey]) return;
    const assignment = assignmentsByReservationId[reservation.reservation_id] || { names: [], note: '' };
    dayBuckets[dateKey].push({
      id: reservation.reservation_id,
      event_type: reservation.event_type,
      event_date: reservation.event_date,
      event_time: reservation.event_time,
      event_end_time: reservation.event_end_time,
      duration_hours: reservation.duration_hours,
      guest_count: reservation.guest_count,
      location_type: reservation.location_type,
      venue_location: reservation.venue_location,
      status: reservation.status,
      updated_at: reservation.updated_at,
      package_name: reservation.package?.package_name || '',
      staff_names: assignment.names,
      manager_notes: assignment.note
    });
  });

  return Object.keys(dayBuckets).sort().map((date) => ({
    date,
    events: dayBuckets[date].sort((a, b) => {
      const aTime = getEventStartDate(a)?.getTime() ?? 0;
      const bTime = getEventStartDate(b)?.getTime() ?? 0;
      return aTime - bTime;
    })
  }));
}

async function refreshSchedule() {
  try {
    state.days = await fetchSchedule();
    state.connectionLost = false;
    state.lastUpdatedAt = new Date();
    render();
    renderFooter();
  } catch (error) {
    state.connectionLost = true;
    renderFooter();
  }
}

function showSignedOutState() {
  boardShell.classList.add('hidden');
  boardSignedOutState.classList.remove('hidden');
}

function showBoard() {
  boardShell.classList.remove('hidden');
  boardSignedOutState.classList.add('hidden');
}

async function checkSession() {
  const { session } = await verifyPortalSession(supabase, { requiredRole: 'staff' });
  if (!session) {
    showSignedOutState();
    return false;
  }
  showBoard();
  return true;
}

async function handleLogout() {
  boardLogoutBtn.disabled = true;
  await supabase.auth.signOut();
  window.location.replace('/admin/index.html');
}

function showLogoutConfirmDialog() {
  boardLogoutConfirmOverlay?.classList.remove('hidden');
}

function hideLogoutConfirmDialog() {
  boardLogoutConfirmOverlay?.classList.add('hidden');
}

function requestLogout() {
  if (!state.kioskMode) {
    handleLogout();
    return;
  }
  showLogoutConfirmDialog();
}

function detectKioskMode() {
  const params = new URLSearchParams(window.location.search);
  const isStandalone = window.matchMedia?.('(display-mode: standalone)')?.matches;
  return params.get('kiosk') === '1' || Boolean(isStandalone);
}

function applyKioskViewport() {
  const viewportMeta = document.querySelector('meta[name="viewport"]');
  if (!viewportMeta) return;
  viewportMeta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
}

async function acquireWakeLock() {
  if (!state.kioskMode || !('wakeLock' in navigator)) return;
  try {
    state.wakeLockSentinel = await navigator.wakeLock.request('screen');
    state.wakeLockSentinel.addEventListener('release', () => {
      state.wakeLockSentinel = null;
    });
  } catch (_err) {
    /* non-fatal — board still works without a wake lock */
  }
}

function goToToday() {
  state.selectedDate = getTodayKey();
  render();
}

function resetIdleTimer() {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    if (state.selectedDate !== getTodayKey()) goToToday();
  }, IDLE_RETURN_MS);
}

async function init() {
  const { session } = await verifyPortalSession(supabase, { requiredRole: 'staff' });
  if (!session) {
    window.location.replace('/admin/index.html');
    return;
  }

  state.kioskMode = detectKioskMode();
  document.body.classList.toggle('kiosk-mode', state.kioskMode);
  if (state.kioskMode) applyKioskViewport();

  state.selectedDate = getTodayKey();

  boardLogoutBtn?.addEventListener('click', requestLogout);
  boardLogoutCancelBtn?.addEventListener('click', hideLogoutConfirmDialog);
  boardLogoutConfirmBtn?.addEventListener('click', () => {
    hideLogoutConfirmDialog();
    handleLogout();
  });
  boardBackToTodayBtn?.addEventListener('click', () => {
    goToToday();
    resetIdleTimer();
  });

  boardWeekDays?.addEventListener('click', (evt) => {
    const row = evt.target.closest('.board-week-row');
    if (!row || !boardWeekDays.contains(row)) return;
    const date = row.getAttribute('data-date');
    if (!date || date === state.selectedDate) return;
    state.selectedDate = date;
    render();
    resetIdleTimer();
  });

  boardShell?.addEventListener('click', resetIdleTimer);
  boardShell?.addEventListener('touchstart', resetIdleTimer, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    acquireWakeLock();
    refreshSchedule();
  });
  window.addEventListener('focus', () => {
    refreshSchedule();
  });

  renderClock();
  await refreshSchedule();
  resetIdleTimer();
  await acquireWakeLock();

  setInterval(renderClock, 1000);
  setInterval(render, 30000);
  setInterval(async () => {
    const stillSignedIn = await checkSession();
    if (stillSignedIn) await refreshSchedule();
  }, 60000);

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') showSignedOutState();
  });
}

init();
