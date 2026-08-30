import Chart from 'https://cdn.jsdelivr.net/npm/chart.js/auto/+esm';
import { portalSupabase as supabase } from './supabase.js';
import { syncCompletedReservations } from './reservation_status.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { getPortalInitials } from './admin_auth.js';
import { initManagerNotificationBell } from './manager_notification_bell.js';
import { initAdminNav } from './admin_nav.js';
import { initAutoRefresh } from './auto_refresh.js';

const sidebarName = document.getElementById('sidebarName');
const sidebarRolePill = document.getElementById('sidebarRolePill');
const sidebarRoleBottom = document.getElementById('sidebarRoleBottom');
const sidebarAvatar = document.getElementById('sidebarAvatar');
const logoutBtn = document.getElementById('logoutBtn');
const dashboardMessage = document.getElementById('dashboardMessage');
const recentReservationsBody = document.getElementById('recentReservationsBody');
const demandYearSelect = document.getElementById('demandYear');
const monthlyYearSelect = document.getElementById('monthlyYear');
const generateForecastBtn = document.getElementById('generateForecastBtn');
const pageDate = document.getElementById('pageDate');
const qaPendingCount = document.getElementById('qaPendingCount');
const API = "https://capstone-website-papg.onrender.com";

if (pageDate) {
    pageDate.textContent = new Date().toLocaleDateString('en-PH', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

let fullData = [];
let fullReservations = [];
let barChart;
let pieChart;
let demandChart;
let statusDonutChart;
let refreshSidebarBadges = () => {};

const statTargets = {
    pending: document.getElementById('pendingReservationsValue'),
    approved: document.getElementById('approvedReservationsValue'),
    completed: document.getElementById('completedEventsValue'),
    customers: document.getElementById('totalCustomersValue')
};

const statusTotalEl = document.getElementById('statusTotal');
const statusLegendEl = document.getElementById('statusLegend');
const packageLegendEl = document.getElementById('packageLegend');

const STATUS_SEGMENT_COLORS = {
    pending: '#BA7517',
    approved: '#3B6D11',
    declined: '#A32D2D',
    completed: '#6B3F23',
    cancelled: '#B4B2A9'
};

const PACKAGE_COLOR_RAMP = ['#4A2C17', '#6B3F23', '#A9805F', '#C9AE9B', '#E2D0BF', '#F0E6D9'];

// Warm the backend as early as possible so cold starts on Render's free
// tier overlap with auth/session checks instead of stacking on top of them.
// Hits the lightweight /health endpoint — no DB/pandas work.
fetch(`${API}/health`).catch(() => {});

async function loadForecast() {
    const res = await fetch(`${API}/forecast`);
    return res.ok ? res.json() : [];
}

async function loadPackages() {
    const res = await fetch(`${API}/analytics/package-distribution`);
    return res.ok ? res.json() : [];
}

function redirectToAdminLogin() {
    window.location.replace('./admin_login.html');
}

function setDashboardMessage(message, isError = false) {
    if (!dashboardMessage) return;
    dashboardMessage.textContent = message;
    dashboardMessage.classList.toggle('error', isError);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatDate(value) {
    if (!value) return 'No date';
    return new Date(value).toLocaleDateString('en-PH', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

function formatStatus(status) {
    const normalized = (status || 'pending').toLowerCase();
    const labelMap = {
        pending: 'Pending',
        confirmed: 'Approved',
        approved: 'Approved',
        declined: 'Declined',
        completed: 'Completed',
        cancelled: 'Cancelled',
        rescheduled: 'Rescheduled'
    };
    return {
        key: normalized,
        label: labelMap[normalized] || normalized.charAt(0).toUpperCase() + normalized.slice(1)
    };
}

function isReservationContractsColumnMissing(error, columnName) {
    const message = error?.message || '';
    return message.includes(`Could not find the '${columnName}' column`)
        || message.includes(`column reservation_contracts.${columnName} does not exist`);
}

function getContractStatusMeta(contract) {
    if (!contract?.contract_url) {
        return { key: 'cancelled', label: 'Missing', sublabel: 'No uploaded file' };
    }
    const reviewStatus = String(contract.review_status || '').toLowerCase();
    if (reviewStatus === 'verified' || contract.verified_date) {
        return { key: 'approved', label: 'Verified', sublabel: 'Ready for approval' };
    }
    if (reviewStatus === 'pending_review' || contract.contract_url) {
        return { key: 'pending', label: 'Pending Review', sublabel: 'Initial contract uploaded' };
    }
    return { key: 'cancelled', label: 'Missing', sublabel: 'No uploaded file' };
}

function isSameLocalDay(a, b) {
    return a.getFullYear() === b.getFullYear()
        && a.getMonth() === b.getMonth()
        && a.getDate() === b.getDate();
}

function isSameLocalMonth(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function setTrend(elId, delta, wordSuffix) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!delta) {
        el.hidden = true;
        el.innerHTML = '';
        return;
    }
    el.hidden = false;
    el.innerHTML = `<span class="trend-delta">+${delta}</span><span class="trend-word">${escapeHtml(wordSuffix)}</span>`;
}

function updateTrends(reservations) {
    const now = new Date();
    let pendingToday = 0;
    let approvedThisMonth = 0;
    let completedThisMonth = 0;
    const firstSeenByCustomer = new Map();

    reservations.forEach((reservation) => {
        const status = (reservation.status || 'pending').toLowerCase();
        const createdAt = reservation.created_at ? new Date(reservation.created_at) : null;
        const eventDate = reservation.event_date ? new Date(reservation.event_date) : null;

        if (status === 'pending' && createdAt && isSameLocalDay(createdAt, now)) pendingToday += 1;
        if ((status === 'confirmed' || status === 'approved') && createdAt && isSameLocalMonth(createdAt, now)) approvedThisMonth += 1;
        if (status === 'completed' && eventDate && isSameLocalMonth(eventDate, now)) completedThisMonth += 1;

        if (reservation.user_id && createdAt) {
            const existing = firstSeenByCustomer.get(reservation.user_id);
            if (!existing || createdAt < existing) firstSeenByCustomer.set(reservation.user_id, createdAt);
        }
    });

    let newCustomersThisMonth = 0;
    firstSeenByCustomer.forEach((firstDate) => {
        if (isSameLocalMonth(firstDate, now)) newCustomersThisMonth += 1;
    });

    setTrend('pendingTrend', pendingToday, 'today');
    setTrend('approvedTrend', approvedThisMonth, 'this month');
    setTrend('completedTrend', completedThisMonth, 'this month');
    setTrend('customersTrend', newCustomersThisMonth, 'this month');
}

// Now takes an optional `year` — defaults to the current year — so the
// monthly reservations chart can be driven by the new year dropdown
// instead of always showing a trailing 6-month window.
function computeMonthlyBreakdown(reservations, year) {
    const targetYear = year ? Number(year) : new Date().getFullYear();
    const months = [];
    for (let m = 0; m <= 11; m += 1) {
        const d = new Date(targetYear, m, 1);
        months.push({
            key: `${targetYear}-${m}`,
            label: d.toLocaleDateString('en-US', { month: 'short' }),
            submitted: 0,
            completed: 0
        });
    }
    const monthByKey = new Map(months.map((m) => [m.key, m]));

    reservations.forEach((reservation) => {
        if (reservation.created_at) {
            const created = new Date(reservation.created_at);
            const bucket = monthByKey.get(`${created.getFullYear()}-${created.getMonth()}`);
            if (bucket) bucket.submitted += 1;
        }
        if ((reservation.status || '').toLowerCase() === 'completed' && reservation.event_date) {
            const eventDate = new Date(reservation.event_date);
            const bucket = monthByKey.get(`${eventDate.getFullYear()}-${eventDate.getMonth()}`);
            if (bucket) bucket.completed += 1;
        }
    });

    return months;
}

// Builds the year dropdown for the monthly reservations chart from whatever
// years actually appear in the reservation data (created_at / event_date),
// always including the current year, and preserves the user's current
// selection across refreshes when possible.
function populateMonthlyYearOptions(reservations) {
    if (!monthlyYearSelect) return;
    const years = new Set();
    reservations.forEach((r) => {
        if (r.created_at) years.add(new Date(r.created_at).getFullYear());
        if (r.event_date) years.add(new Date(r.event_date).getFullYear());
    });
    const currentYear = new Date().getFullYear();
    years.add(currentYear);

    const previousValue = monthlyYearSelect.value;
    const sortedYears = [...years].sort((a, b) => a - b);

    monthlyYearSelect.innerHTML = '';
    sortedYears.forEach((year) => {
        const option = document.createElement('option');
        option.value = String(year);
        option.textContent = String(year);
        monthlyYearSelect.appendChild(option);
    });

    monthlyYearSelect.value = sortedYears.map(String).includes(previousValue)
        ? previousValue
        : String(currentYear);
}

function renderMonthlyChart(reservations, year) {
    const months = computeMonthlyBreakdown(reservations, year);
    const ctx = document.getElementById('barChart');
    if (!ctx) return;
    if (barChart) barChart.destroy();
    barChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: months.map((m) => m.label),
            datasets: [
                {
                    label: 'Reservations',
                    data: months.map((m) => m.submitted),
                    backgroundColor: '#4A2C17',
                    borderRadius: 3,
                    borderSkipped: false
                },
                {
                    label: 'Completed',
                    data: months.map((m) => m.completed),
                    backgroundColor: '#A9805F',
                    borderRadius: 3,
                    borderSkipped: false
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    align: 'start',
                    labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'rect', font: { size: 11 }, color: '#7A6A5C' }
                }
            },
            scales: {
                x: { grid: { display: false }, ticks: { color: '#7A6A5C', font: { size: 11 } } },
                y: { beginAtZero: true, grid: { color: '#F1EFE8' }, ticks: { precision: 0, color: '#7A6A5C', font: { size: 11 } } }
            }
        }
    });
}

function renderPackageChart(data) {
    const sorted = [...(data || [])].sort((a, b) => (b.count || 0) - (a.count || 0));
    const colors = sorted.map((_, i) => PACKAGE_COLOR_RAMP[i % PACKAGE_COLOR_RAMP.length]);

    const ctx = document.getElementById('pieChart');
    if (ctx) {
        if (pieChart) pieChart.destroy();
        pieChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: sorted.map((d) => d.package),
                datasets: [{
                    data: sorted.map((d) => d.count),
                    backgroundColor: colors,
                    borderWidth: 0,
                    hoverOffset: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '55%',
                plugins: { legend: { display: false } }
            }
        });
    }

    if (packageLegendEl) {
        packageLegendEl.innerHTML = sorted.length
            ? sorted.map((d, i) => `
                <li>
                    <span class="legend-swatch" style="background:${colors[i]}"></span>
                    <span class="legend-label">${escapeHtml(d.package)}</span>
                </li>`).join('')
            : `<li class="legend-empty">No package data yet.</li>`;
    }
}

function renderDemandChart(year) {
    const filtered = fullData.filter((d) => d.year === year);
    const allMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dataMap = {};
    filtered.forEach((d) => { dataMap[d.month_name] = d; });
    const actual = allMonths.map((month) => { const d = dataMap[month]; return d ? d.y : 0; });
    const forecast = allMonths.map((month) => {
        const d = dataMap[month];
        return d && d.yhat !== null && d.yhat !== undefined ? Math.round(d.yhat) : null;
    });
    const ctx = document.getElementById('demandChart');
    if (!ctx) return;
    if (demandChart) demandChart.destroy();
    demandChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: allMonths,
            datasets: [
                {
                    label: 'Actual',
                    data: actual,
                    borderColor: '#4A2C17',
                    backgroundColor: '#4A2C17',
                    borderWidth: 2,
                    pointRadius: 3,
                    pointBackgroundColor: '#4A2C17',
                    pointBorderColor: '#fff',
                    tension: 0.25,
                    spanGaps: true
                },
                {
                    label: 'Forecast',
                    data: forecast,
                    borderColor: '#BA7517',
                    backgroundColor: '#BA7517',
                    borderWidth: 2,
                    borderDash: [5, 4],
                    pointRadius: 3,
                    pointBackgroundColor: '#BA7517',
                    pointBorderColor: '#fff',
                    tension: 0.25,
                    spanGaps: true
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'top', align: 'end', labels: { font: { size: 11 }, color: '#7A6A5C', boxWidth: 8, boxHeight: 8 } }
            },
            scales: {
                x: { grid: { color: '#F1EFE8' }, ticks: { color: '#7A6A5C', font: { size: 11 } } },
                y: { beginAtZero: true, grid: { color: '#F1EFE8' }, ticks: { color: '#7A6A5C', font: { size: 11 }, precision: 0 } }
            }
        }
    });
}

function renderStatusDonut(totals, total) {
    const segments = [
        { key: 'pending', label: 'Pending', value: totals.pending },
        { key: 'approved', label: 'Approved', value: totals.approved },
        { key: 'declined', label: 'Declined', value: totals.declined },
        { key: 'completed', label: 'Completed', value: totals.completed },
        { key: 'cancelled', label: 'Cancelled/rescheduled', value: totals.cancelled + totals.rescheduled }
    ]
        .map((s) => ({ ...s, color: STATUS_SEGMENT_COLORS[s.key] }))
        .sort((a, b) => b.value - a.value);

    const ctx = document.getElementById('statusDonut');
    if (ctx) {
        if (statusDonutChart) statusDonutChart.destroy();
        statusDonutChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: segments.map((s) => s.label),
                datasets: [{
                    data: segments.map((s) => s.value),
                    backgroundColor: segments.map((s) => s.color),
                    borderWidth: 0,
                    hoverOffset: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '70%',
                plugins: { legend: { display: false } }
            }
        });
    }

    if (statusTotalEl) statusTotalEl.textContent = String(total);

    if (statusLegendEl) {
        statusLegendEl.innerHTML = segments.map((s) => {
            const pct = total > 0 ? (s.value / total) * 100 : 0;
            return `
                <li>
                    <span class="legend-swatch" style="background:${s.color}"></span>
                    <span class="legend-label">${escapeHtml(s.label)}</span>
                    <span class="legend-count">${s.value}</span>
                    <span class="legend-pct">${pct.toFixed(1)}%</span>
                </li>`;
        }).join('');
    }
}

function updateStats(reservations) {
    const totals = { pending: 0, approved: 0, declined: 0, completed: 0, cancelled: 0, rescheduled: 0 };
    const customerIds = new Set();
    reservations.forEach((reservation) => {
        const status = (reservation.status || 'pending').toLowerCase();
        if (status === 'pending') totals.pending += 1;
        if (status === 'confirmed' || status === 'approved') totals.approved += 1;
        if (status === 'declined') totals.declined += 1;
        if (status === 'completed') totals.completed += 1;
        if (status === 'cancelled') totals.cancelled += 1;
        if (status === 'rescheduled') totals.rescheduled += 1;
        if (reservation.user_id) customerIds.add(reservation.user_id);
    });
    if (statTargets.pending) statTargets.pending.textContent = String(totals.pending);
    if (statTargets.approved) statTargets.approved.textContent = String(totals.approved);
    if (statTargets.completed) statTargets.completed.textContent = String(totals.completed);
    if (statTargets.customers) statTargets.customers.textContent = String(customerIds.size);
    if (qaPendingCount) qaPendingCount.textContent = `${totals.pending} pending approval`;

    updateTrends(reservations);

    const total = reservations.length;
    renderStatusDonut(totals, total);
}

function renderReservationsTable(reservations, contractsByReservationId = {}) {
    if (!recentReservationsBody) return;
    if (!reservations.length) {
        recentReservationsBody.innerHTML = `<tr><td colspan="7">No reservations found yet.</td></tr>`;
        return;
    }
    recentReservationsBody.innerHTML = reservations.slice(0, 10).map((reservation) => {
        const customerName = reservation.contact_name || 'Unknown customer';
        const customerEmail = reservation.contact_email || 'No email';
        const packageName = reservation.package?.package_name || 'No package selected';
        const location = reservation.location_type === 'onsite'
            ? 'Onsite - ELI Coffee'
            : `Offsite - ${reservation.venue_location || 'Venue not provided'}`;
        const status = formatStatus(reservation.status);
        const contractStatus = getContractStatusMeta(contractsByReservationId[reservation.reservation_id]);
        const contractCell = contractStatus.key === 'cancelled'
            ? `<span class="no-contract">No contract</span>`
            : `<span class="status-pill ${escapeHtml(contractStatus.key)}">${escapeHtml(contractStatus.label)}</span><span class="table-sub">${escapeHtml(contractStatus.sublabel)}</span>`;
        return `
            <tr>
                <td><span class="table-main">${escapeHtml(customerName)}</span><span class="table-sub">${escapeHtml(customerEmail)}</span></td>
                <td><span class="table-main">${escapeHtml(reservation.event_type || 'Event')}</span><span class="table-sub">Submitted ${escapeHtml(formatDate(reservation.created_at))}</span></td>
                <td><span class="table-main date-cell">${escapeHtml(formatDate(reservation.event_date))}</span><span class="table-sub">${escapeHtml(reservation.event_time || 'No time selected')}</span></td>
                <td><span class="table-main">${escapeHtml(packageName)}</span><span class="table-sub">${escapeHtml(String(reservation.guest_count || 0))} guests</span></td>
                <td class="location-cell" title="${escapeHtml(location)}">${escapeHtml(location)}</td>
                <td>${contractCell}</td>
                <td><span class="status-pill ${escapeHtml(status.key)}">${escapeHtml(status.label)}</span></td>
            </tr>`;
    }).join('');
}

async function fetchReservations() {
    const { data, error } = await supabase
        .from('reservations')
        .select(`
            reservation_id, user_id, event_type, event_date, event_time,
            guest_count, location_type, venue_location, contact_name,
            contact_email, total_price, status, created_at,
            package:package_id (package_name, package_type)
        `)
        .order('created_at', { ascending: false });
    if (error) throw error;
    return syncCompletedReservations({ supabase, reservations: data || [] });
}

async function fetchContracts(reservationIds) {
    if (!reservationIds.length) return {};
    const { data, error } = await supabase
        .from('reservation_contracts')
        .select('reservation_id, contract_url, verified_date, review_status')
        .in('reservation_id', reservationIds);
    if (error) {
        if (isReservationContractsColumnMissing(error, 'review_status')) {
            const fallback = await supabase
                .from('reservation_contracts')
                .select('reservation_id, contract_url, verified_date')
                .in('reservation_id', reservationIds);
            if (fallback.error) throw fallback.error;
            return (fallback.data || []).reduce((map, c) => { map[c.reservation_id] = c; return map; }, {});
        }
        throw error;
    }
    return (data || []).reduce((map, c) => { map[c.reservation_id] = c; return map; }, {});
}

async function loadPaymentsTodayStat() {
    const paymentsTodayEl = document.getElementById('paymentsTodayValue');
    if (!paymentsTodayEl) return;
    try {
        const todayKey = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
        const { count, error } = await supabase
            .from('payment')
            .select('payment_id', { count: 'exact', head: true })
            .eq('payment_source', 'in_cafe')
            .eq('actual_payment_date', todayKey);
        if (error) throw error;
        paymentsTodayEl.textContent = String(count || 0);
    } catch (error) {
        paymentsTodayEl.textContent = '—';
    }
}

// silent=true is used by the auto-refresh triggers (focus/visibility, bfcache
// restore, background poll). Unlike the manual/initial load, it must not
// blank the stats/table/chart before fetching (that produced a visible
// flash-to-zero on every refresh) and it skips the package/forecast calls,
// which are expensive (the forecast hits the Render backend, which can have
// a slow cold start) and not time-sensitive enough to re-run every 60s.
async function loadDashboard({ silent = false } = {}) {
    if (!silent) {
        setDashboardMessage('Loading reservations...');
        updateStats([]);
        renderReservationsTable([], {});
        renderMonthlyChart([]);
    }
    loadPaymentsTodayStat();

    let reservationsCount = 0;
    let hasError = false;

    const fastPath = (async () => {
        try {
            const reservations = await fetchReservations();
            fullReservations = reservations;
            reservationsCount = reservations.length;
            updateStats(reservations);
            renderReservationsTable(reservations, {});
            populateMonthlyYearOptions(reservations);
            renderMonthlyChart(reservations, monthlyYearSelect?.value);
            refreshSidebarBadges();
            const reservationIds = reservations.map((r) => r.reservation_id).filter(Boolean);
            const contractsByReservationId = await fetchContracts(reservationIds);
            renderReservationsTable(reservations, contractsByReservationId);
        } catch (error) {
            hasError = true;
            if (silent) {
                console.warn('Auto-refresh failed, keeping last loaded dashboard data:', error.message);
            } else {
                setDashboardMessage('Failed to load reservations. Please try again.', true);
            }
        }
    })();

    const otherPromises = silent ? [] : [
        loadPackages()
            .then((data) => renderPackageChart(data))
            .catch(() => renderPackageChart([])),
        loadForecast()
            .then(async (data) => {
                fullData = Array.isArray(data) ? data : [];
                if (demandYearSelect && fullData.length) {
                    const years = [...new Set(fullData.map((d) => d.year))].sort();
                    demandYearSelect.innerHTML = '';
                    years.forEach((year) => {
                        const option = document.createElement('option');
                        option.value = year;
                        option.textContent = year;
                        demandYearSelect.appendChild(option);
                    });
                    const currentYear = new Date().getFullYear().toString();
                    demandYearSelect.value = years.includes(currentYear) ? currentYear : years[years.length - 1];
                }
                const selectedYear = demandYearSelect?.value;
                if (selectedYear) renderDemandChart(selectedYear);
            })
            .catch(() => {})
    ];

   await Promise.allSettled([fastPath, ...otherPromises]);

   if (!hasError && !silent) {
        setDashboardMessage(
            reservationsCount
                ? `Showing ${Math.min(reservationsCount, 10)} of ${reservationsCount} reservation(s).`
                : 'No reservations available yet.'
        );
    }
}

function formatHourMinute(hhmm) {
    if (!hhmm) return null;
    const [h, m] = hhmm.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const hour12 = ((h + 11) % 12) + 1;
    return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

async function loadSystemOverview() {
    const ovPackageCount = document.getElementById('ovPackageCount');
    const ovAccountCount = document.getElementById('ovAccountCount');
    const ovLastBackup = document.getElementById('ovLastBackup');
    const ovBookingHours = document.getElementById('ovBookingHours');
    if (!ovPackageCount && !ovAccountCount && !ovLastBackup && !ovBookingHours) return;

    const [pkgRes, profilesRes, settingsRes] = await Promise.all([
        supabase.from('package').select('package_id', { count: 'exact', head: true }).eq('is_active', true),
        supabase.from('profiles').select('role').eq('is_locked', false).in('role', ['manager', 'staff', 'admin']),
        supabase.from('system_settings').select('setting_key, setting_value').in('setting_key', ['last_backup_at', 'booking_operating_hours'])
    ]);

    if (ovPackageCount) {
        ovPackageCount.textContent = pkgRes.count ?? 0;
    }

    if (ovAccountCount) {
        const counts = { manager: 0, staff: 0, admin: 0 };
        (profilesRes.data || []).forEach((row) => { if (counts[row.role] !== undefined) counts[row.role] += 1; });
        ovAccountCount.textContent = `${counts.manager} mgr · ${counts.staff} staff · ${counts.admin} admin`;
    }

    const settingsByKey = {};
    (settingsRes.data || []).forEach((row) => { settingsByKey[row.setting_key] = row.setting_value; });

    if (ovLastBackup) {
        const raw = settingsByKey.last_backup_at;
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                ovLastBackup.textContent = new Date(parsed.created_at).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
            } catch {
                ovLastBackup.textContent = 'Unavailable';
            }
        } else {
            ovLastBackup.textContent = 'No backup yet';
        }
    }

    if (ovBookingHours) {
        const raw = settingsByKey.booking_operating_hours;
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                const open = formatHourMinute(parsed.open_time);
                const close = formatHourMinute(parsed.close_time);
                ovBookingHours.textContent = (open && close) ? `${open} – ${close}` : 'Not set';
            } catch {
                ovBookingHours.textContent = 'Unavailable';
            }
        } else {
            ovBookingHours.textContent = 'Not set';
        }
    }
}

// MANUAL FORECAST GENERATION
generateForecastBtn?.addEventListener('click', async () => {
    generateForecastBtn.disabled = true;
    generateForecastBtn.textContent = 'Generating…';

    try {
        const { data: { session } } = await supabase.auth.getSession();
        const userId = session?.user?.id ?? null;

        const res = await fetch(`${API}/forecast/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId })
        });

        const result = await res.json();
        if (!res.ok) throw new Error(result.detail || 'Unknown error');

        const fresh = await loadForecast();
        fullData = Array.isArray(fresh) ? fresh : [];
        if (demandYearSelect && fullData.length) {
            const years = [...new Set(fullData.map((d) => d.year))].sort();
            demandYearSelect.innerHTML = '';
            years.forEach((year) => {
                const option = document.createElement('option');
                option.value = year;
                option.textContent = year;
                demandYearSelect.appendChild(option);
            });
            const currentYear = new Date().getFullYear().toString();
            demandYearSelect.value = years.includes(currentYear) ? currentYear : years[years.length - 1];
        }
        const selectedYear = demandYearSelect?.value;
        if (selectedYear) renderDemandChart(selectedYear);

        setDashboardMessage('Forecast regenerated successfully.');
    } catch (err) {
        setDashboardMessage(`Forecast generation failed: ${err.message}`, true);
    } finally {
        generateForecastBtn.disabled = false;
        generateForecastBtn.textContent = 'Update Forecast';
    }
});

// Auto-refresh replaces the old manual Refresh button — see the matching
// block in js/admin_reservations.js for the full rationale. Debounced so a
// focus + visibilitychange pair (which fire together when switching back to
// this tab) can't trigger a duplicate fetch.
initAutoRefresh(() => loadDashboard({ silent: true }));

demandYearSelect?.addEventListener('change', () => { renderDemandChart(demandYearSelect.value); });
monthlyYearSelect?.addEventListener('change', () => { renderMonthlyChart(fullReservations, monthlyYearSelect.value); });

wireLogoutButton();
watchAuthState();

validateAdminSession({
    onSuccess: ({ session, profile }) => {
        setupInactivityLogout(profile.role);
        if (sidebarAvatar) sidebarAvatar.textContent = getPortalInitials(profile);
        if (sidebarRoleBottom) sidebarRoleBottom.textContent = profile.role === 'admin' ? 'Admin' : 'Manager';
        refreshSidebarBadges = initAdminSidebarBadges(supabase);
        initAdminNav({ role: profile.role });
        initManagerNotificationBell(supabase, session.user.id);
        loadDashboard();
        if (profile.role === 'admin') loadSystemOverview();
    }
});