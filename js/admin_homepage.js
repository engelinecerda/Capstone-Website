import Chart from 'https://cdn.jsdelivr.net/npm/chart.js/auto/+esm';
import { portalSupabase as supabase } from './supabase.js';
import { getEffectiveReservationStatus, syncCompletedReservations } from './reservation_status.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';

const sidebarName = document.getElementById('sidebarName');
const sidebarEmail = document.getElementById('sidebarEmail');
const sidebarRolePill = document.getElementById('sidebarRolePill');
const badge = document.getElementById('adminBadge');
const sidebarTitle = document.getElementById('sidebarTitle');
const logoutBtn = document.getElementById('logoutBtn');
const refreshDashboardBtn = document.getElementById('refreshDashboardBtn');
const dashboardMessage = document.getElementById('dashboardMessage');
const recentReservationsBody = document.getElementById('recentReservationsBody');
const demandYearSelect = document.getElementById('demandYear');
const API = "https://capstone-website-papg.onrender.com";

let fullData = [];
let barChart;
let pieChart;
let demandChart;
let refreshSidebarBadges = () => {};

const statTargets = {
    pending: document.getElementById('pendingReservationsValue'),
    approved: document.getElementById('approvedReservationsValue'),
    completed: document.getElementById('completedEventsValue'),
    customers: document.getElementById('totalCustomersValue'),
    replacementContracts: document.getElementById('replacementContractsValue')
};

const chipTargets = {
    pending: document.getElementById('chipPending'),
    approved: document.getElementById('chipApproved'),
    declined: document.getElementById('chipDeclined'),
    completed: document.getElementById('chipCompleted'),
    cancelled: document.getElementById('chipCancelled'),
    rescheduled: document.getElementById('chipRescheduled')
};

async function loadForecast() {
    const res = await fetch(`${API}/forecast`);
    return res.ok ? res.json() : [];
}

async function loadMonthly() {
    const res = await fetch(`${API}/analytics/monthly-reservations`);
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
    if (reviewStatus === 'resubmission_requested') {
        return { key: 'resubmission_requested', label: 'Fix Requested', sublabel: 'Waiting for customer' };
    }
    if (reviewStatus === 'pending_review' && contract.resubmitted_at) {
        return { key: 'resubmitted', label: 'Replacement Submitted', sublabel: 'Needs admin review' };
    }
    if (reviewStatus === 'pending_review' || contract.contract_url) {
        return { key: 'pending', label: 'Pending Review', sublabel: 'Initial contract uploaded' };
    }
    return { key: 'cancelled', label: 'Missing', sublabel: 'No uploaded file' };
}

async function renderBarChart(data) {
    const labels = data.map(d => d.month);
    const values = data.map(d => d.count);
    const ctx = document.getElementById('barChart');
    if (!ctx) return;
    if (barChart) barChart.destroy();
    barChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Reservations',
                data: values,
                backgroundColor: '#6b3a2a',
                borderRadius: 6,
                borderSkipped: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { display: false }, ticks: { color: '#9ca3af' } },
                y: { beginAtZero: true, ticks: { precision: 0, color: '#9ca3af' } }
            }
        }
    });
}

async function renderPieChart(data) {
    const labels = data.map(d => d.package);
    const values = data.map(d => d.count);
    const ctx = document.getElementById('pieChart');
    if (!ctx) return;
    if (pieChart) pieChart.destroy();
    pieChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{
                data: values,
                backgroundColor: ['#6b3a2a', '#a0522d', '#c9833a', '#d4a574', '#e8d5c0', '#b08b66'],
                borderWidth: 0,
                hoverOffset: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '55%',
            plugins: {
                legend: {
                    position: 'right',
                    labels: { color: '#374151', padding: 14, usePointStyle: true }
                }
            }
        }
    });
}

async function renderDemandChart(year) {
    const filtered = fullData.filter(d => d.year === year);
    const allMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dataMap = {};
    filtered.forEach(d => { dataMap[d.month_name] = d; });
    const actual = allMonths.map(month => { const d = dataMap[month]; return d ? d.y : 0; });
    const forecast = allMonths.map(month => {
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
                    borderColor: '#6b4a32',
                    backgroundColor: '#6b4a32',
                    borderWidth: 2,
                    pointRadius: 4,
                    pointBackgroundColor: '#6b4a32',
                    pointBorderColor: '#fff',
                    tension: 0.25,
                    spanGaps: true
                },
                {
                    label: 'Forecast',
                    data: forecast,
                    borderColor: '#c79c73',
                    backgroundColor: '#c79c73',
                    borderWidth: 2,
                    borderDash: [6, 6],
                    pointRadius: 4,
                    pointBackgroundColor: '#c79c73',
                    pointBorderColor: '#fff',
                    tension: 0.25,
                    spanGaps: true
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'top', labels: { color: '#374151' } } },
            scales: {
                x: { grid: { color: '#f3f0eb' }, ticks: { color: '#9ca3af' } },
                y: { beginAtZero: true, grid: { color: '#f3f0eb' }, ticks: { color: '#9ca3af', precision: 0 } }
            }
        }
    });
}

function updateStats(reservations, contractsByReservationId = {}) {
    const totals = { pending: 0, approved: 0, declined: 0, completed: 0, cancelled: 0, rescheduled: 0, replacementContracts: 0 };
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
        const contract = contractsByReservationId[reservation.reservation_id];
        if (String(contract?.review_status || '').toLowerCase() === 'pending_review' && contract?.resubmitted_at) {
            totals.replacementContracts += 1;
        }
    });
    if (statTargets.pending) statTargets.pending.textContent = String(totals.pending);
    if (statTargets.approved) statTargets.approved.textContent = String(totals.approved);
    if (statTargets.completed) statTargets.completed.textContent = String(totals.completed);
    if (statTargets.customers) statTargets.customers.textContent = String(customerIds.size);
    if (statTargets.replacementContracts) statTargets.replacementContracts.textContent = String(totals.replacementContracts);
    if (chipTargets.pending) chipTargets.pending.textContent = String(totals.pending);
    if (chipTargets.approved) chipTargets.approved.textContent = String(totals.approved);
    if (chipTargets.declined) chipTargets.declined.textContent = String(totals.declined);
    if (chipTargets.completed) chipTargets.completed.textContent = String(totals.completed);
    if (chipTargets.cancelled) chipTargets.cancelled.textContent = String(totals.cancelled);
    if (chipTargets.rescheduled) chipTargets.rescheduled.textContent = String(totals.rescheduled);
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
        return `
            <tr>
                <td><span class="table-main">${escapeHtml(customerName)}</span><span class="table-sub">${escapeHtml(customerEmail)}</span></td>
                <td><span class="table-main">${escapeHtml(reservation.event_type || 'Event')}</span><span class="table-sub">Submitted ${escapeHtml(formatDate(reservation.created_at))}</span></td>
                <td><span class="table-main">${escapeHtml(formatDate(reservation.event_date))}</span><span class="table-sub">${escapeHtml(reservation.event_time || 'No time selected')}</span></td>
                <td><span class="table-main">${escapeHtml(packageName)}</span><span class="table-sub">${escapeHtml(String(reservation.guest_count || 0))} guests</span></td>
                <td>${escapeHtml(location)}</td>
                <td><span class="status-pill ${escapeHtml(contractStatus.key)}">${escapeHtml(contractStatus.label)}</span><span class="table-sub">${escapeHtml(contractStatus.sublabel)}</span></td>
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
        .select('reservation_id, contract_url, verified_date, review_status, resubmitted_at')
        .in('reservation_id', reservationIds);
    if (error) {
        if (isReservationContractsColumnMissing(error, 'review_status') || isReservationContractsColumnMissing(error, 'resubmitted_at')) {
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

async function loadDashboard() {
    setDashboardMessage('Loading reservations...');
    updateStats([], {});
    renderReservationsTable([], {});

    let reservationsCount = 0;
    let replacementContracts = 0;
    let hasError = false;

    const fastPath = (async () => {
        try {
            const reservations = await fetchReservations();
            reservationsCount = reservations.length;
            updateStats(reservations, {});
            renderReservationsTable(reservations, {});
            refreshSidebarBadges();
            const reservationIds = reservations.map((r) => r.reservation_id).filter(Boolean);
            const contractsByReservationId = await fetchContracts(reservationIds);
            replacementContracts = Object.values(contractsByReservationId)
                .filter((c) => String(c?.review_status || '').toLowerCase() === 'pending_review' && c?.resubmitted_at)
                .length;
            updateStats(reservations, contractsByReservationId);
            renderReservationsTable(reservations, contractsByReservationId);
        } catch (error) {
            console.error('Failed to load reservations/contracts:', error);
            hasError = true;
            setDashboardMessage(`Failed to load reservations: ${error?.message || 'unknown error'}.`, true);
        }
    })();

    const monthlyPromise = loadMonthly()
        .then((data) => renderBarChart(data))
        .catch((error) => { console.error('Failed to load monthly chart:', error); return renderBarChart([]); });

    const packagePromise = loadPackages()
        .then((data) => renderPieChart(data))
        .catch((error) => { console.error('Failed to load package chart:', error); return renderPieChart([]); });

    const forecastPromise = loadForecast()
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
            if (selectedYear) await renderDemandChart(selectedYear);
        })
        .catch((error) => { console.error('Failed to load forecast:', error); });

    await Promise.allSettled([fastPath, monthlyPromise, packagePromise, forecastPromise]);

    if (!hasError) {
        setDashboardMessage(
            reservationsCount
                ? `Showing ${Math.min(reservationsCount, 10)} of ${reservationsCount} reservation(s). ${replacementContracts} replacement contract${replacementContracts === 1 ? '' : 's'} waiting for review.`
                : 'No reservations available yet.'
        );
    }
}

refreshDashboardBtn?.addEventListener('click', async () => { await loadDashboard(); });
demandYearSelect?.addEventListener('change', () => { renderDemandChart(demandYearSelect.value); });

wireLogoutButton();
watchAuthState();

validateAdminSession({
    onSuccess: ({ profile }) => {
        setupInactivityLogout(profile.role);
        refreshSidebarBadges = initAdminSidebarBadges(supabase);
        loadDashboard();
    }
});
