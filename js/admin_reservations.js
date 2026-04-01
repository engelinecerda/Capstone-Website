import { supabase } from './supabase.js';

const ADMIN_EMAIL = 'adminelicoffee@gmail.com';

const tableMessage = document.getElementById('tableMessage');
const reservationsBody = document.getElementById('reservationsBody');
const searchInput = document.getElementById('searchInput');
const statusDropdown = document.getElementById('statusDropdown');
const chipsRow = document.getElementById('chipsRow');
const refreshBtn = document.getElementById('refreshBtn');
const statIds = ['pending', 'approved', 'declined', 'completed', 'total'];
const calendarGrid = document.getElementById('calendarGrid');
const calendarMonthLabel = document.getElementById('calendarMonthLabel');
const prevMonthBtn = document.getElementById('prevMonth');
const nextMonthBtn = document.getElementById('nextMonth');
const calendarMessage = document.getElementById('calendarMessage');
const adminEmailEl = document.getElementById('adminEmail');
const adminStatusEl = document.getElementById('adminStatus');
const logoutBtn = document.getElementById('logoutBtn');

let reservationsCache = [];
let blackouts = new Set();
let currentMonth = new Date();

function setMessage(el, msg, isError = false) {
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

async function validateAdmin() {
  const { data, error } = await supabase.auth.getSession();
  if (error) return redirectLogin();
  const session = data.session;
  const email = session?.user?.email?.toLowerCase();
  if (!session || email !== ADMIN_EMAIL) {
    await supabase.auth.signOut();
    return redirectLogin();
  }
  adminEmailEl.textContent = email;
  adminStatusEl.textContent = 'Authenticated';
  return session;
}

function redirectLogin() {
  window.location.replace('./admin_login.html');
}

function formatStatusPill(status) {
  const key = (status || 'pending').toLowerCase();
  const label = key.charAt(0).toUpperCase() + key.slice(1);
  return { key, label };
}

function contractStatus(res) {
  const c = res.contracts?.[0];
  if (!c) return { label: 'Not uploaded', key: 'default' };
  if (c.verified_date) return { label: 'Verified', key: 'approved' };
  if (c.status === 'rejected') return { label: 'Rejected', key: 'declined' };
  return { label: 'Pending review', key: 'pending' };
}

function paymentStatus(res) {
  const s = (res.status || '').toLowerCase();
  if (s === 'completed') return 'Fully paid';
  if (s === 'approved' || s === 'confirmed') return 'Pending verification';
  return 'Not started';
}

function matchesSearch(res, term) {
  if (!term) return true;
  const needle = term.toLowerCase();
  return (res.contact_name || '').toLowerCase().includes(needle)
      || (res.contact_email || '').toLowerCase().includes(needle);
}

function matchesStatus(res, status) {
  if (status === 'all') return true;
  return (res.status || '').toLowerCase() === status;
}

function renderStats(list) {
  const counts = {
    pending: 0, approved: 0, declined: 0, completed: 0,
    cancelled: 0, rescheduled: 0, total: list.length
  };
  list.forEach(r => {
    const k = (r.status || 'pending').toLowerCase();
    if (counts[k] !== undefined) counts[k] += 1;
  });
  statIds.forEach(id => {
    const el = document.getElementById(`stat-${id}`);
    if (el) el.textContent = counts[id] ?? 0;
  });
  chipsRow?.querySelectorAll('.chip').forEach(chip => {
    const status = chip.dataset.status;
    const val = status === 'all' ? counts.total : (counts[status] ?? 0);
    chip.textContent = `${chip.textContent.split('(')[0].trim()} (${val})`;
  });
}

function renderTable(list) {
  if (!reservationsBody) return;
  if (!list.length) {
    reservationsBody.innerHTML = '<tr><td colspan="6">No reservations found.</td></tr>';
    return;
  }
  reservationsBody.innerHTML = list.map(res => {
    const pkg = res.package?.package_name || '—';
    const contract = contractStatus(res);
    const pay = paymentStatus(res);
    const status = formatStatusPill(res.status);
    return `
      <tr>
        <td>
          <span class="table-main">${escapeHtml(res.contact_name || 'Unknown')}</span>
          <span class="table-sub">${escapeHtml(res.contact_email || '')}</span>
        </td>
        <td>${escapeHtml(pkg)}</td>
        <td><span class="status-pill ${escapeHtml(contract.key)}">${escapeHtml(contract.label)}</span></td>
        <td>${escapeHtml(pay)}</td>
        <td><span class="status-pill ${escapeHtml(status.key)}">${escapeHtml(status.label)}</span></td>
        <td class="actions">
          <button class="action-btn approve" data-action="approve" data-id="${res.reservation_id}">Approve</button>
          <button class="action-btn decline" data-action="decline" data-id="${res.reservation_id}">Decline</button>
          <button class="action-btn request" data-action="request" data-id="${res.reservation_id}">Request Resubmission</button>
          ${res.contracts?.[0]?.contract_url ? `<a class="action-btn view" href="${res.contracts[0].contract_url}" target="_blank" rel="noopener noreferrer">View Contract</a>` : ''}
        </td>
      </tr>
    `;
  }).join('');
}

function filterAndRender() {
  const term = searchInput?.value.trim().toLowerCase();
  const dropdownStatus = statusDropdown?.value || 'all';
  const chipStatus = chipsRow?.querySelector('.chip.active')?.dataset.status || 'all';
  const status = dropdownStatus !== 'all' ? dropdownStatus : chipStatus;
  const filtered = reservationsCache.filter(r => matchesStatus(r, status) && matchesSearch(r, term));
  renderStats(reservationsCache);
  renderTable(filtered);
  setMessage(tableMessage, filtered.length ? '' : 'No reservations match the current filter.', false);
}

function wireFilters() {
  searchInput?.addEventListener('input', filterAndRender);
  statusDropdown?.addEventListener('change', () => {
    chipsRow?.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    filterAndRender();
  });
  chipsRow?.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    chipsRow.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    statusDropdown.value = 'all';
    filterAndRender();
  });
}

async function fetchReservations() {
  const { data, error } = await supabase
    .from('reservations')
    .select(`
      reservation_id,
      contact_name,
      contact_email,
      status,
      event_date,
      package:package_id ( package_name ),
      contracts:contracts ( contract_url, verified_date, status )
    `)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function updateReservationStatus(reservationId, status) {
  const { error } = await supabase
    .from('reservations')
    .update({ status })
    .eq('reservation_id', reservationId);
  if (error) throw error;
}

function wireTableActions() {
  reservationsBody?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.action-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    try {
      setMessage(tableMessage, 'Updating...', false);
      if (action === 'approve') await updateReservationStatus(id, 'approved');
      if (action === 'decline') await updateReservationStatus(id, 'declined');
      if (action === 'request') await updateReservationStatus(id, 'resubmission_requested');
      await loadData();
      setMessage(tableMessage, 'Updated.', false);
    } catch (err) {
      setMessage(tableMessage, `Failed to update: ${err.message}`, true);
    }
  });
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}
function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function renderCalendar(approvedDates = []) {
  if (!calendarGrid) return;
  const start = startOfMonth(currentMonth);
  const end = endOfMonth(currentMonth);
  const firstWeekday = start.getDay();
  const daysInMonth = end.getDate();
  const approvedSet = new Set(approvedDates.map(d => d.split('T')[0]));
  const closedSet = blackouts;

  calendarGrid.innerHTML = '';
  for (let i = 0; i < firstWeekday; i++) {
    const cell = document.createElement('div');
    cell.className = 'calendar-cell muted';
    cell.innerHTML = '&nbsp;';
    calendarGrid.appendChild(cell);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateObj = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), day);
    const iso = dateObj.toISOString().split('T')[0];
    const cell = document.createElement('div');
    cell.className = 'calendar-cell';
    const booked = approvedSet.has(iso);
    const closed = closedSet.has(iso);
    if (booked) cell.classList.add('booked');
    if (closed) cell.classList.add('closed');
    cell.innerHTML = `
      <div class="day">${day}</div>
      <div class="label">${booked ? 'Fully booked' : closed ? 'Closed' : 'Available'}</div>
    `;
    if (!booked) {
      cell.addEventListener('click', () => toggleBlackout(iso));
      cell.style.cursor = 'pointer';
    } else {
      cell.style.cursor = 'not-allowed';
    }
    calendarGrid.appendChild(cell);
  }
  calendarMonthLabel.textContent = currentMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
}

async function fetchBlackouts() {
  try {
    const { data, error } = await supabase.from('calendar_blackouts').select('date');
    if (error) throw error;
    blackouts = new Set((data || []).map(row => row.date));
  } catch (err) {
    setMessage(calendarMessage, `Calendar note: ${err.message} (blackouts table missing?)`, true);
  }
}

async function toggleBlackout(dateIso) {
  if (blackouts.has(dateIso)) {
    const { error } = await supabase.from('calendar_blackouts').delete().eq('date', dateIso);
    if (error) {
      setMessage(calendarMessage, `Failed to open date: ${error.message}`, true);
      return;
    }
    blackouts.delete(dateIso);
  } else {
    const { error } = await supabase.from('calendar_blackouts').upsert({ date: dateIso });
    if (error) {
      setMessage(calendarMessage, `Failed to close date: ${error.message}`, true);
      return;
    }
    blackouts.add(dateIso);
  }
  renderCalendar(approvedDatesFromCache());
}

function approvedDatesFromCache() {
  return reservationsCache
    .filter(r => (r.status || '').toLowerCase() === 'approved' && r.event_date)
    .map(r => r.event_date);
}

async function loadCalendar() {
  await fetchBlackouts();
  renderCalendar(approvedDatesFromCache());
}

async function loadData() {
  setMessage(tableMessage, 'Loading reservations...');
  try {
    reservationsCache = await fetchReservations();
    renderStats(reservationsCache);
    filterAndRender();
    await loadCalendar();
  } catch (err) {
    setMessage(tableMessage, `Failed to load: ${err.message}`, true);
    renderTable([]);
  }
}

function wireCalendarNav() {
  prevMonthBtn?.addEventListener('click', () => {
    currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
    renderCalendar(approvedDatesFromCache());
  });
  nextMonthBtn?.addEventListener('click', () => {
    currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
    renderCalendar(approvedDatesFromCache());
  });
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

logoutBtn?.addEventListener('click', async () => {
  await supabase.auth.signOut();
  redirectLogin();
});

refreshBtn?.addEventListener('click', loadData);

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') redirectLogin();
});

(async function init() {
  await validateAdmin();
  wireFilters();
  wireTableActions();
  wireCalendarNav();
  await loadData();
})();
