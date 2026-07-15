import { portalSupabase as supabase } from './supabase.js';
import { verifyPortalSession } from './admin_auth.js';

const boardClock = document.getElementById('boardClock');
const boardDate = document.getElementById('boardDate');
const boardTodaySub = document.getElementById('boardTodaySub');
const boardTodayList = document.getElementById('boardTodayList');
const boardWeekDays = document.getElementById('boardWeekDays');
const boardFooterMessage = document.getElementById('boardFooterMessage');
const boardStatusDot = document.getElementById('boardStatusDot');
const boardShell = document.getElementById('boardShell');
const boardSignedOutState = document.getElementById('boardSignedOutState');

const state = {
  days: [],
  lastUpdatedAt: null,
  connectionLost: false
};

const STATUS_META = {
  approved: { key: 'approved', label: 'Confirmed' },
  confirmed: { key: 'approved', label: 'Confirmed' },
  partially_paid: { key: 'approved', label: 'Confirmed' },
  fully_paid: { key: 'approved', label: 'Confirmed' },
  rescheduled: { key: 'approved', label: 'Confirmed' },
  completed: { key: 'completed', label: 'Completed' }
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
    return '<span class="board-staff-pending">Staff to be assigned</span>';
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
  if (now >= start && now <= end) return { key: 'now', label: 'Happening now' };
  if (now < start) {
    const diffMinutes = Math.round((start.getTime() - now.getTime()) / 60000);
    const hours = Math.floor(diffMinutes / 60);
    const minutes = diffMinutes % 60;
    const parts = [];
    if (hours) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);
    return { key: 'next', label: `in ${parts.join(' ')}` };
  }
  return null;
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

function findUpNextEventId(todayEvents, now) {
  const upcoming = todayEvents
    .map((event) => ({ event, start: getEventStartDate(event) }))
    .filter((entry) => entry.start && entry.start > now)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  return upcoming.length ? upcoming[0].event.id : null;
}

function renderEventCard(event, now, upNextId) {
  const status = getStatusMeta(event.status);
  const flag = computeEventFlag(event, now);
  const isUpNext = event.id === upNextId;
  const flagHtml = flag && (flag.key === 'now' || isUpNext)
    ? `<span class="board-flag board-flag-${flag.key}">${flag.key === 'now' ? '<i class="fa-solid fa-circle-play"></i> Happening now' : `<i class="fa-solid fa-clock"></i> Up next · ${escapeHtml(flag.label)}`}</span>`
    : '';

  const startTime = getEventStartDate(event);
  const endTime = getEventEndDate(event);
  const timeLabel = startTime && endTime
    ? `${startTime.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })} – ${endTime.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })}`
    : (event.event_time || 'Time TBD');

  return `
    <article class="board-event-card${isUpNext ? ' board-event-up-next' : ''}">
      <div class="board-event-time">${escapeHtml(timeLabel)}</div>
      <div class="board-event-body">
        <div class="board-event-head">
          <h3 class="board-event-title">${escapeHtml(event.event_type || 'Reserved Event')}</h3>
          <span class="status-pill ${escapeHtml(status.key)}">${escapeHtml(status.label)}</span>
        </div>
        <p class="board-event-meta">${escapeHtml(event.package_name || 'Package pending')} · ${escapeHtml(String(event.guest_count || 0))} guests · ${escapeHtml(getLocationLabel(event))}</p>
        <div class="board-staff-chips">${getStaffChipsHtml(event)}</div>
        ${event.manager_notes ? `<p class="board-event-notes"><i class="fa-solid fa-note-sticky"></i> ${escapeHtml(event.manager_notes)}</p>` : ''}
        ${flagHtml}
      </div>
    </article>
  `;
}

function render() {
  const now = new Date();
  const todayKey = getTodayKey();
  const todayEntry = state.days.find((day) => day.date === todayKey);
  const todayEvents = todayEntry?.events || [];
  const upNextId = findUpNextEventId(todayEvents, now);

  boardTodaySub.textContent = todayEvents.length
    ? `${todayEvents.length} event${todayEvents.length === 1 ? '' : 's'} scheduled`
    : 'No events scheduled today';

  boardTodayList.innerHTML = todayEvents.length
    ? todayEvents.map((event) => renderEventCard(event, now, upNextId)).join('')
    : '<div class="board-empty-day"><i class="fa-solid fa-mug-hot"></i><p>No events today</p></div>';

  boardWeekDays.innerHTML = state.days.map((day) => {
    const isToday = day.date === todayKey;
    const eventsHtml = day.events.length
      ? day.events.map((event) => `
          <div class="board-week-event">
            <span class="board-week-event-time">${escapeHtml(event.event_time || '')}</span>
            <span class="board-week-event-name">${escapeHtml(event.event_type || 'Reserved Event')}</span>
          </div>
        `).join('')
      : '<p class="board-week-empty">No events</p>';

    return `
      <div class="board-week-row${isToday ? ' board-week-row-today' : ''}">
        <p class="board-week-row-label">${escapeHtml(formatDayLabel(day.date, isToday))}</p>
        <div class="board-week-row-events">${eventsHtml}</div>
      </div>
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

async function init() {
  const { session } = await verifyPortalSession(supabase, { requiredRole: 'staff' });
  if (!session) {
    window.location.replace('/admin/index.html');
    return;
  }

  renderClock();
  await refreshSchedule();

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
