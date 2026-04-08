import Chart from 'https://cdn.jsdelivr.net/npm/chart.js/auto/+esm';
import { portalSupabase as supabase } from './supabase.js';
import { populatePortalIdentity, verifyAdminSession } from './admin_auth.js';

const sidebarName = document.getElementById('sidebarName');
const sidebarEmail = document.getElementById('sidebarEmail');
const sidebarRolePill = document.getElementById('sidebarRolePill');
const logoutBtn = document.getElementById('logoutBtn');
const refreshDashboardBtn = document.getElementById('refreshDashboardBtn');
const dashboardMessage = document.getElementById('dashboardMessage');
const recentReservationsBody = document.getElementById('recentReservationsBody');
const navReservationCount = document.getElementById('navReservationCount');
const demandYearSelect = document.getElementById('demandYear');

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

let barChart;
let pieChart;
let demandChart;

const demandDataByYear = {
    2024: {
        labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
        actual: [1, 1, 12, 4, 3, 5, 3, 4, 2, 4, 0, 0],
        forecast: [1, 1, 12, 4, 3, 5, 3, 4, 2, 4, 0, 0]
    },
    2025: {
        labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
        actual: [2, 2, 10, 5, 4, 6, 4, 5, 3, 5, 1, 1],
        forecast: [2, 2, 10, 5, 4, 6, 4, 5, 3, 5, 6, 8]
    },
    2026: {
        labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
        actual: [1, 1, 12, 4, 3, 5, 3, 4, 2, 4, 0, 0],
        forecast: [1, 1, 12, 4, 3, 5, 3, 4, 2, 4, 9, 13]
    }
};

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

function createEmptyMonthlyBuckets() {
    const buckets = [];
    const now = new Date();

    for (let offset = 5; offset >= 0; offset -= 1) {
        buckets.push(new Date(now.getFullYear(), now.getMonth() - offset, 1));
    }

    return buckets;
}

function buildMonthlyDataset(reservations) {
    const buckets = createEmptyMonthlyBuckets();
    const counts = new Map(
        buckets.map((date) => [
            `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
            0
        ])
    );

    reservations.forEach((reservation) => {
        if (!reservation.created_at) return;
        const created = new Date(reservation.created_at);
        const key = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}`;
        if (counts.has(key)) {
            counts.set(key, counts.get(key) + 1);
        }
    });

    return {
        labels: buckets.map((date) =>
            date.toLocaleDateString('en-US', { month: 'short' })
        ),
        values: buckets.map((date) => {
            const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            return counts.get(key) || 0;
        })
    };
}

function buildPackageDataset(reservations) {
    const counts = new Map();

    reservations.forEach((reservation) => {
        const type = reservation.package?.package_type
            || reservation.package?.package_name
            || reservation.location_type
            || 'Other';

        const label = String(type)
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (char) => char.toUpperCase());

        counts.set(label, (counts.get(label) || 0) + 1);
    });

    const labels = Array.from(counts.keys());
    const values = Array.from(counts.values());

    if (labels.length === 0) {
        return {
            labels: ['No Data'],
            values: [1]
        };
    }

    return { labels, values };
}

function renderBarChart(dataset) {
    const ctx = document.getElementById('barChart');
    if (!ctx) return;

    if (barChart) {
        barChart.destroy();
    }

    barChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: dataset.labels,
            datasets: [{
                label: 'Reservations',
                data: dataset.values,
                backgroundColor: '#6b3a2a',
                borderRadius: 6,
                borderSkipped: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: '#9ca3af' }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: '#f3f0eb', borderDash: [4, 4] },
                    ticks: { precision: 0, color: '#9ca3af' }
                }
            }
        }
    });
}

function renderPieChart(dataset) {
    const ctx = document.getElementById('pieChart');
    if (!ctx) return;

    if (pieChart) {
        pieChart.destroy();
    }

    pieChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: dataset.labels,
            datasets: [{
                data: dataset.values,
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
                    labels: {
                        color: '#374151',
                        padding: 14,
                        usePointStyle: true,
                        pointStyleWidth: 8
                    }
                }
            }
        }
    });
}

function renderDemandChart(year) {
    const ctx = document.getElementById('demandChart');
    if (!ctx) return;

    const data = demandDataByYear[year] || demandDataByYear[Object.keys(demandDataByYear)[0]];
    if (!data) return;

    if (demandChart) {
        demandChart.destroy();
    }

    demandChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.labels,
            datasets: [
                {
                    label: 'Actual',
                    data: data.actual,
                    borderColor: '#6b4a32',
                    backgroundColor: '#6b4a32',
                    borderWidth: 2,
                    pointRadius: 4,
                    pointBackgroundColor: '#6b4a32',
                    pointBorderColor: '#fff',
                    tension: 0.25
                },
                {
                    label: 'Forecast',
                    data: data.forecast,
                    borderColor: '#c79c73',
                    backgroundColor: '#c79c73',
                    borderWidth: 2,
                    borderDash: [6, 6],
                    pointRadius: 0,
                    tension: 0.25
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'top',
                    labels: { color: '#374151' }
                }
            },
            scales: {
                x: {
                    grid: { color: '#f3f0eb' },
                    ticks: { color: '#9ca3af' }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: '#f3f0eb' },
                    ticks: { color: '#9ca3af', precision: 0 }
                }
            }
        }
    });
}

function updateStats(reservations, contractsByReservationId = {}) {
    const totals = {
        pending: 0,
        approved: 0,
        declined: 0,
        completed: 0,
        cancelled: 0,
        rescheduled: 0,
        replacementContracts: 0
    };

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
    if (navReservationCount) navReservationCount.textContent = String(totals.pending);

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
        recentReservationsBody.innerHTML = `
            <tr>
                <td colspan="7">No reservations found yet.</td>
            </tr>
        `;
        return;
    }

    recentReservationsBody.innerHTML = reservations
        .slice(0, 10)
        .map((reservation) => {
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
                    <td>
                        <span class="table-main">${escapeHtml(customerName)}</span>
                        <span class="table-sub">${escapeHtml(customerEmail)}</span>
                    </td>
                    <td>
                        <span class="table-main">${escapeHtml(reservation.event_type || 'Event')}</span>
                        <span class="table-sub">Submitted ${escapeHtml(formatDate(reservation.created_at))}</span>
                    </td>
                    <td>
                        <span class="table-main">${escapeHtml(formatDate(reservation.event_date))}</span>
                        <span class="table-sub">${escapeHtml(reservation.event_time || 'No time selected')}</span>
                    </td>
                    <td>
                        <span class="table-main">${escapeHtml(packageName)}</span>
                        <span class="table-sub">${escapeHtml(String(reservation.guest_count || 0))} guests</span>
                    </td>
                    <td>${escapeHtml(location)}</td>
                    <td>
                        <span class="status-pill ${escapeHtml(contractStatus.key)}">${escapeHtml(contractStatus.label)}</span>
                        <span class="table-sub">${escapeHtml(contractStatus.sublabel)}</span>
                    </td>
                    <td><span class="status-pill ${escapeHtml(status.key)}">${escapeHtml(status.label)}</span></td>
                </tr>
            `;
        })
        .join('');
}

async function fetchReservations() {
    const { data, error } = await supabase
        .from('reservations')
        .select(`
            reservation_id,
            user_id,
            event_type,
            event_date,
            event_time,
            guest_count,
            location_type,
            venue_location,
            contact_name,
            contact_email,
            total_price,
            status,
            created_at,
            package:package_id (
                package_name,
                package_type
            )
        `)
        .order('created_at', { ascending: false });

    if (error) {
        throw error;
    }

    return data || [];
}

async function fetchContracts(reservationIds) {
    if (!reservationIds.length) return {};

    const { data, error } = await supabase
        .from('reservation_contracts')
        .select('reservation_id, contract_url, verified_date, review_status, resubmitted_at')
        .in('reservation_id', reservationIds);

    if (error) {
        if (
            isReservationContractsColumnMissing(error, 'review_status')
            || isReservationContractsColumnMissing(error, 'resubmitted_at')
        ) {
            const fallback = await supabase
                .from('reservation_contracts')
                .select('reservation_id, contract_url, verified_date')
                .in('reservation_id', reservationIds);

            if (fallback.error) throw fallback.error;

            return (fallback.data || []).reduce((map, contract) => {
                map[contract.reservation_id] = contract;
                return map;
            }, {});
        }

        throw error;
    }

    return (data || []).reduce((map, contract) => {
        map[contract.reservation_id] = contract;
        return map;
    }, {});
}

async function loadDashboard() {
    setDashboardMessage('Loading reservations...');

    try {
        const reservations = await fetchReservations();
        const reservationIds = reservations.map((reservation) => reservation.reservation_id).filter(Boolean);
        const contractsByReservationId = await fetchContracts(reservationIds);
        const replacementContracts = Object.values(contractsByReservationId)
            .filter((contract) => String(contract?.review_status || '').toLowerCase() === 'pending_review' && contract?.resubmitted_at)
            .length;

        updateStats(reservations, contractsByReservationId);
        renderReservationsTable(reservations, contractsByReservationId);
        renderBarChart(buildMonthlyDataset(reservations));
        renderPieChart(buildPackageDataset(reservations));
        const selectedYear = demandYearSelect?.value || '2026';
        renderDemandChart(selectedYear);

        const summaryText = reservations.length
            ? `Showing ${Math.min(reservations.length, 10)} of ${reservations.length} reservation(s). ${replacementContracts} replacement contract${replacementContracts === 1 ? '' : 's'} waiting for review.`
            : 'No reservations available yet.';

        setDashboardMessage(summaryText);
    } catch (error) {
        console.error('Failed to load admin dashboard:', error);
        setDashboardMessage(
            `Failed to load reservations: ${error?.message || 'unknown error'}. If this admin account should see all bookings, check RLS policies and the admin role.`,
            true
        );
        updateStats([], {});
        renderReservationsTable([], {});
        renderBarChart(buildMonthlyDataset([]));
        renderPieChart(buildPackageDataset([]));
        const selectedYear = demandYearSelect?.value || '2026';
        renderDemandChart(selectedYear);
    }
}

async function validateAdminSession() {
    const { session, profile } = await verifyAdminSession(supabase);

    if (!session) {
        await supabase.auth.signOut();
        redirectToAdminLogin();
        return null;
    }

    populatePortalIdentity({
        profile,
        session,
        nameEl: sidebarName,
        emailEl: sidebarEmail,
        roleEl: sidebarRolePill,
        fallbackLabel: 'Admin'
    });

    return session;
}

logoutBtn?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    redirectToAdminLogin();
});

refreshDashboardBtn?.addEventListener('click', async () => {
    await loadDashboard();
});

demandYearSelect?.addEventListener('change', () => {
    const selectedYear = demandYearSelect.value;
    renderDemandChart(selectedYear);
});

supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
        redirectToAdminLogin();
    }
});

const session = await validateAdminSession();
if (session) {
    await loadDashboard();
}
