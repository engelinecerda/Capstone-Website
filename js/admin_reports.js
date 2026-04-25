import { portalSupabase as supabase } from './supabase.js';
import { populatePortalIdentity, verifyAdminSession } from './admin_auth.js';
import { refreshAdminSidebarCounts } from './admin_sidebar_counts.js';
import {
    getEffectiveReservationStatus,
    syncCompletedReservations
} from './reservation_status.js';

const sidebarName = document.getElementById('sidebarName');
const sidebarEmail = document.getElementById('sidebarEmail');
const sidebarRolePill = document.getElementById('sidebarRolePill');
const sidebarAvatar = document.getElementById('sidebarAvatar');
const logoutBtn = document.getElementById('logoutBtn');
const refreshReportsBtn = document.getElementById('refreshReportsBtn');
const exportPdfBtn = document.getElementById('exportPdfBtn');
const reportDateFrom = document.getElementById('reportDateFrom');
const reportDateTo = document.getElementById('reportDateTo');
const reportSearch = document.getElementById('reportSearch');
const reportsMessage = document.getElementById('reportsMessage');
const reportsSummary = document.getElementById('reportsSummary');
const reportsTableBody = document.getElementById('reportsTableBody');
const navReservationCount = document.getElementById('navReservationCount');
const navContractCount = document.getElementById('navContractCount');
const navPaymentCount = document.getElementById('navPaymentCount');
const navReviewCount = document.getElementById('navReviewCount');

const state = {
    reservations: []
};

function redirectToAdminLogin() {
    window.location.replace('/admin/index.html');
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatCurrency(value) {
    return `PHP ${Number(value || 0).toLocaleString()}`;
}

function formatDate(value) {
    if (!value) return 'No date';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'No date';
    return date.toLocaleDateString('en-PH', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

function formatStatusLabel(status) {
    const normalized = String(status || 'pending').toLowerCase();
    const labels = {
        pending: 'Pending',
        approved: 'Approved',
        declined: 'Declined',
        completed: 'Completed',
        cancelled: 'Cancelled',
        rescheduled: 'Rescheduled'
    };
    return labels[normalized] || normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function setReportsMessage(message, isError = false) {
    if (!reportsMessage) return;
    reportsMessage.textContent = message;
    reportsMessage.classList.toggle('error', isError);
}

function getCustomerName(reservation) {
    return reservation?.contact_name || reservation?.contact_email || 'Customer';
}

function getCustomerEmail(reservation) {
    return reservation?.contact_email || 'No email';
}

function getPackageName(reservation) {
    return reservation?.package?.package_name || reservation?.package_id || 'No package';
}

function getFilteredReservations() {
    const fromValue = reportDateFrom?.value || '';
    const toValue = reportDateTo?.value || '';
    const searchValue = String(reportSearch?.value || '').trim().toLowerCase();

    return state.reservations.filter((reservation) => {
        const eventDate = String(reservation?.event_date || '').split('T')[0];
        if (fromValue && eventDate && eventDate < fromValue) {
            return false;
        }
        if (toValue && eventDate && eventDate > toValue) {
            return false;
        }

        if (!searchValue) {
            return true;
        }

        const haystack = [
            getCustomerName(reservation),
            getCustomerEmail(reservation),
            reservation?.event_type,
            getPackageName(reservation)
        ].join(' ').toLowerCase();

        return haystack.includes(searchValue);
    });
}

function buildSummaryCards(reservations) {
    const totals = reservations.reduce((summary, reservation) => {
        const status = getEffectiveReservationStatus(reservation);
        summary.totalReservations += 1;
        summary.totalGuests += Number(reservation?.guest_count || 0);
        summary[status] = (summary[status] || 0) + 1;
        return summary;
    }, {
        totalReservations: 0,
        totalGuests: 0,
        pending: 0,
        approved: 0,
        completed: 0,
        cancelled: 0,
        declined: 0,
        rescheduled: 0
    });

    return [
        { label: 'Total Reservations', value: totals.totalReservations, copy: 'Filtered bookings included in this report.' },
        { label: 'Total Guests', value: totals.totalGuests, copy: 'Combined guest count across the filtered reservations.' },
        { label: 'Pending', value: totals.pending, copy: 'Reservations still waiting for admin action.' },
        { label: 'Approved', value: totals.approved, copy: 'Approved active bookings that are not yet completed.' },
        { label: 'Completed', value: totals.completed, copy: 'Past reservations already treated as completed.' },
        { label: 'Cancelled', value: totals.cancelled, copy: 'Cancelled reservations within the selected range.' },
        { label: 'Declined', value: totals.declined, copy: 'Reservations that were declined.' },
        { label: 'Rescheduled', value: totals.rescheduled, copy: 'Reservations currently marked as rescheduled.' }
    ];
}

function renderSummary(reservations) {
    const cards = buildSummaryCards(reservations);
    reportsSummary.innerHTML = cards.map((card) => `
        <article class="report-summary-card">
            <div class="report-summary-label">${escapeHtml(card.label)}</div>
            <div class="report-summary-value">${escapeHtml(String(card.value))}</div>
            <div class="report-summary-copy">${escapeHtml(card.copy)}</div>
        </article>
    `).join('');
}

function renderTable(reservations) {
    if (!reservations.length) {
        reportsTableBody.innerHTML = `
            <tr>
                <td colspan="6">
                    <div class="reports-empty">No reservations match the current report filters.</div>
                </td>
            </tr>
        `;
        return;
    }

    reportsTableBody.innerHTML = reservations.map((reservation) => {
        const status = getEffectiveReservationStatus(reservation);
        return `
            <tr>
                <td>
                    <strong>${escapeHtml(getCustomerName(reservation))}</strong>
                    <span>${escapeHtml(getCustomerEmail(reservation))}</span>
                </td>
                <td>
                    <strong>${escapeHtml(reservation?.event_type || 'Reservation')}</strong>
                    <span>${escapeHtml(reservation?.location_type || 'Location not set')}</span>
                </td>
                <td>
                    <strong>${escapeHtml(formatDate(reservation?.event_date))}</strong>
                    <span>${escapeHtml(reservation?.event_time || 'No time selected')}</span>
                </td>
                <td>
                    <strong>${escapeHtml(getPackageName(reservation))}</strong>
                    <span>${escapeHtml(reservation?.package?.package_type || 'Package')}</span>
                </td>
                <td><span class="reports-status-chip ${escapeHtml(status)}">${escapeHtml(formatStatusLabel(status))}</span></td>
                <td><strong>${escapeHtml(formatCurrency(reservation?.total_price || 0))}</strong></td>
            </tr>
        `;
    }).join('');
}

function renderReports() {
    const filteredReservations = getFilteredReservations();
    renderSummary(filteredReservations);
    renderTable(filteredReservations);
    setReportsMessage(`${filteredReservations.length} reservation(s) currently included in this report.`);
}

function exportReportsPdf() {
    const filteredReservations = getFilteredReservations();
    if (!filteredReservations.length) {
        setReportsMessage('Add a date range or adjust the search so at least one reservation can be exported.', true);
        return;
    }

    const JsPdfConstructor = window.jspdf?.jsPDF;
    if (!JsPdfConstructor) {
        setReportsMessage('PDF export is not available because jsPDF did not load.', true);
        return;
    }

    const doc = new JsPdfConstructor({
        orientation: 'landscape',
        unit: 'pt',
        format: 'a4'
    });

    const cards = buildSummaryCards(filteredReservations);
    const filenameDate = new Date().toISOString().slice(0, 10);
    const rangeLabel = [
        reportDateFrom?.value ? `From ${reportDateFrom.value}` : '',
        reportDateTo?.value ? `To ${reportDateTo.value}` : ''
    ].filter(Boolean).join('  ');

    doc.setFontSize(18);
    doc.text('ELI Coffee Events Reservation Report', 40, 42);
    doc.setFontSize(11);
    doc.text(rangeLabel || 'All reservation dates', 40, 62);

    let summaryY = 84;
    cards.slice(0, 6).forEach((card, index) => {
        const column = index % 3;
        const row = Math.floor(index / 3);
        const x = 40 + (column * 250);
        const y = summaryY + (row * 48);
        doc.setFontSize(10);
        doc.text(card.label, x, y);
        doc.setFontSize(16);
        doc.text(String(card.value), x, y + 18);
    });

    if (typeof doc.autoTable !== 'function') {
        setReportsMessage('PDF export is not available because the table plugin did not load.', true);
        return;
    }

    doc.autoTable({
        startY: 196,
        head: [['Customer', 'Event', 'Schedule', 'Package', 'Status', 'Total Price']],
        body: filteredReservations.map((reservation) => ([
            `${getCustomerName(reservation)}\n${getCustomerEmail(reservation)}`,
            reservation?.event_type || 'Reservation',
            `${formatDate(reservation?.event_date)}\n${reservation?.event_time || 'No time selected'}`,
            getPackageName(reservation),
            formatStatusLabel(getEffectiveReservationStatus(reservation)),
            formatCurrency(reservation?.total_price || 0)
        ])),
        styles: {
            fontSize: 9,
            cellPadding: 7
        },
        headStyles: {
            fillColor: [78, 54, 36]
        }
    });

    doc.save(`reservation-report-${filenameDate}.pdf`);
    setReportsMessage(`Exported ${filteredReservations.length} reservation(s) to PDF.`);
}

async function fetchReservations() {
    const { data, error } = await supabase
        .from('reservations')
        .select(`
            reservation_id,
            user_id,
            contact_name,
            contact_email,
            event_type,
            event_date,
            event_time,
            guest_count,
            location_type,
            total_price,
            status,
            created_at,
            package:package_id (
                package_name,
                package_type
            )
        `)
        .order('event_date', { ascending: false });

    if (error) {
        throw error;
    }

    return syncCompletedReservations({
        supabase,
        reservations: data || []
    });
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
        avatarEl: sidebarAvatar,
        fallbackLabel: 'Admin'
    });

    return session;
}

async function loadReports() {
    setReportsMessage('Loading reservations...');

    try {
        state.reservations = await fetchReservations();
        renderReports();
        await refreshAdminSidebarCounts({
            supabase,
            reservationBadgeEl: navReservationCount,
            paymentBadgeEl: navPaymentCount,
            contractBadgeEl: navContractCount,
            reviewBadgeEl: navReviewCount
        });
    } catch (error) {
        console.error('Failed to load reservation reports:', error);
        reportsSummary.innerHTML = '';
        reportsTableBody.innerHTML = `
            <tr>
                <td colspan="6">
                    <div class="reports-empty">We could not load reservation data for reports.</div>
                </td>
            </tr>
        `;
        setReportsMessage(error?.message || 'Failed to load reservation reports.', true);
    }
}

logoutBtn?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    redirectToAdminLogin();
});

refreshReportsBtn?.addEventListener('click', loadReports);
exportPdfBtn?.addEventListener('click', exportReportsPdf);
reportDateFrom?.addEventListener('input', renderReports);
reportDateTo?.addEventListener('input', renderReports);
reportSearch?.addEventListener('input', renderReports);

supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
        redirectToAdminLogin();
    }
});

const session = await validateAdminSession();
if (session) {
    await loadReports();
}
