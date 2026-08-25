import { portalSupabase as supabase } from './supabase.js';
import { populatePortalIdentity, verifyMultiRoleSession } from './admin_auth.js';
import { refreshAdminSidebarCounts } from './admin_sidebar_counts.js';
import { initAdminNav } from './admin_nav.js';
import { applyRoleVisibility } from './session_validation.js';
import { initManagerNotificationBell } from './manager_notification_bell.js';
import {
    getEffectiveReservationStatus,
    getReservationStatusMeta,
    syncCompletedReservations
} from './reservation_status.js';
import { PAGE_SIZE, paginate, renderPagination, getTotalPages } from './pagination.js'; 

const sidebarName = document.getElementById('sidebarName');
const sidebarEmail = document.getElementById('sidebarEmail');
const sidebarRolePill = document.getElementById('sidebarRolePill');
const sidebarAvatar = document.getElementById('sidebarAvatar');
const logoutBtn = document.getElementById('logoutBtn');
const exportExcelBtn = document.getElementById('exportExcelBtn');
const reportDateFrom = document.getElementById('reportDateFrom');
const reportDateTo = document.getElementById('reportDateTo');
const reportSearch = document.getElementById('reportSearch');
const reportsMessage = document.getElementById('reportsMessage');
const reportsSummary = document.getElementById('reportsSummary');
const reportsTableBody = document.getElementById('reportsTableBody');
const reportsPagination = document.getElementById('reportsPagination');
const navReservationCount = document.getElementById('navReservationCount');
const navContractCount = document.getElementById('navContractCount');
const navPaymentCount = document.getElementById('navPaymentCount');
const navReviewCount = document.getElementById('navReviewCount');

let reportsFiltered = [];
let reportsCurrentPage = 1;

const state = {
    reservations: [],
    paymentSummaryMap: {}
};

async function fetchPaymentSummaries(reservationIds) {
    if (!reservationIds.length) return {};
    const { data, error } = await supabase
        .from('reservation_payment_summary')
        .select('reservation_id, total_paid')
        .in('reservation_id', reservationIds);
    if (error) throw error;
    return (data || []).reduce((map, row) => {
        map[row.reservation_id] = row;
        return map;
    }, {});
}

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
        summary.totalPaid += Number(state.paymentSummaryMap[reservation.reservation_id]?.total_paid || 0);
        return summary;
    }, {
        totalReservations: 0,
        totalGuests: 0,
        pending: 0,
        approved: 0,
        completed: 0,
        cancelled: 0,
        declined: 0,
        rescheduled: 0,
        totalPaid: 0
    });

    return [
        { label: 'Total Reservations', value: totals.totalReservations, copy: 'Filtered bookings included in this report.' },
        { label: 'Total Guests', value: totals.totalGuests, copy: 'Combined guest count across the filtered reservations.' },
        { label: 'Pending', value: totals.pending, copy: 'Reservations still waiting for admin action.' },
        { label: 'Approved', value: totals.approved, copy: 'Approved active bookings that are not yet completed.' },
        { label: 'Completed', value: totals.completed, copy: 'Past reservations already treated as completed.' },
        { label: 'Cancelled', value: totals.cancelled, copy: 'Cancelled reservations within the selected range.' },
        { label: 'Declined', value: totals.declined, copy: 'Reservations that were declined.' },
        { label: 'Rescheduled', value: totals.rescheduled, copy: 'Reservations currently marked as rescheduled.' },
        { label: 'Payments Collected', value: `₱${totals.totalPaid.toLocaleString()}`, copy: 'Total approved payments across the filtered reservations.' }
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
                <td><span class="status-pill ${escapeHtml(getReservationStatusMeta(status).key)}">${escapeHtml(getReservationStatusMeta(status).label)}</span></td>
                <td><strong>${escapeHtml(formatCurrency(reservation?.total_price || 0))}</strong></td>
            </tr>
        `;
    }).join('');
}

function renderReports({ resetPage = true } = {}) {
    const filteredReservations = getFilteredReservations();
    renderSummary(filteredReservations);
    reportsFiltered = filteredReservations;
    if (resetPage) {
        reportsCurrentPage = 1;
    } else {
        reportsCurrentPage = Math.min(reportsCurrentPage, getTotalPages(filteredReservations.length, PAGE_SIZE));
    }
    renderReportsTablePage();
    setReportsMessage(`${filteredReservations.length} reservation(s) currently included in this report.`);
}

function renderReportsTablePage() {
    renderTable(paginate(reportsFiltered, reportsCurrentPage, PAGE_SIZE));
    renderPagination(reportsPagination, {
        totalItems: reportsFiltered.length,
        currentPage: reportsCurrentPage,
        pageSize: PAGE_SIZE,
        onPageChange: (page) => {
            reportsCurrentPage = page;
            renderReportsTablePage();
        }
    });
}

const RESV_COLUMNS = [
    { header: 'Customer Name', key: 'customerName', width: 24 },
    { header: 'Customer Email', key: 'customerEmail', width: 26 },
    { header: 'Event Type', key: 'eventType', width: 18 },
    { header: 'Location Type', key: 'locationType', width: 16 },
    { header: 'Event Date', key: 'eventDate', width: 14 },
    { header: 'Event Time', key: 'eventTime', width: 16 },
    { header: 'Package Name', key: 'packageName', width: 22 },
    { header: 'Package Type', key: 'packageType', width: 16 },
    { header: 'Guest Count', key: 'guestCount', width: 12 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Total Price', key: 'totalPrice', width: 16 },
    { header: 'Amount Paid', key: 'amountPaid', width: 16 }
];
const CURRENCY_FORMAT = '"₱"#,##0.00';
const REPORT_FONT = { name: 'Arial', size: 10 };

function buildReportHeaderRows(sheet, subtitle) {
    const titleRow = sheet.addRow(['ELI Coffee Events']);
    titleRow.getCell(1).font = { name: 'Arial', size: 14, bold: true };

    const subtitleRow = sheet.addRow([subtitle]);
    subtitleRow.getCell(1).font = { name: 'Arial', size: 12, bold: true };

    const rangeLabel = [
        reportDateFrom?.value ? `From ${reportDateFrom.value}` : '',
        reportDateTo?.value ? `To ${reportDateTo.value}` : ''
    ].filter(Boolean).join('  ') || 'All reservation dates';
    const rangeRow = sheet.addRow([`Date range: ${rangeLabel}`]);
    rangeRow.getCell(1).font = REPORT_FONT;

    const generatedRow = sheet.addRow([`Generated on: ${new Date().toLocaleString('en-PH')}`]);
    generatedRow.getCell(1).font = REPORT_FONT;

    sheet.addRow([]);
}

// 1-based column index within RESV_COLUMNS/a data row — used instead of
// ExcelJS's key-based addRow()/worksheet.columns, since setting
// worksheet.columns with `header` entries writes its own header row at
// row 1 unconditionally, which would clobber this sheet's own title block
// already sitting in row 1.
function colIndex(key) {
    return RESV_COLUMNS.findIndex((c) => c.key === key) + 1;
}

function buildReservationsSheet(workbook, reservations) {
    const sheet = workbook.addWorksheet('Reservations');
    buildReportHeaderRows(sheet, 'Reservation Report — Reservations');

    const headerRowNumber = sheet.rowCount + 1;
    const headerRow = sheet.addRow(RESV_COLUMNS.map((col) => col.header));
    headerRow.eachCell((cell) => {
        cell.font = { name: 'Arial', size: 10, bold: true };
    });

    reservations.forEach((reservation) => {
        const eventDate = reservation?.event_date ? new Date(reservation.event_date) : null;
        const row = sheet.addRow([
            getCustomerName(reservation),
            getCustomerEmail(reservation),
            reservation?.event_type || 'Reservation',
            reservation?.location_type || 'Location not set',
            eventDate && !Number.isNaN(eventDate.getTime()) ? eventDate : null,
            reservation?.event_time || 'No time selected',
            getPackageName(reservation),
            reservation?.package?.package_type || 'Package',
            Number(reservation?.guest_count || 0),
            formatStatusLabel(getEffectiveReservationStatus(reservation)),
            Number(reservation?.total_price || 0),
            Number(state.paymentSummaryMap[reservation.reservation_id]?.total_paid || 0)
        ]);
        row.getCell(colIndex('eventDate')).numFmt = 'mmm d, yyyy';
        row.getCell(colIndex('totalPrice')).numFmt = CURRENCY_FORMAT;
        row.getCell(colIndex('amountPaid')).numFmt = CURRENCY_FORMAT;
        row.eachCell((cell) => { cell.font = REPORT_FONT; });
    });

    RESV_COLUMNS.forEach((col, i) => { sheet.getColumn(i + 1).width = col.width; });
    sheet.views = [{ state: 'frozen', ySplit: headerRowNumber }];

    return { sheet, headerRowNumber, lastRow: sheet.rowCount };
}

function buildSummarySheet(workbook, resvRef) {
    const sheet = workbook.addWorksheet('Summary');
    buildReportHeaderRows(sheet, 'Reservation Report — Summary');

    const headerRowNumber = sheet.rowCount + 1;
    const headerRow = sheet.addRow(['Metric', 'Value']);
    headerRow.eachCell((cell) => {
        cell.font = { name: 'Arial', size: 10, bold: true };
    });

    // First/last data row on the Reservations sheet, for the formulas below
    // — exportReportsExcel() already returns before this is called if there
    // are zero filtered reservations, so there's always at least one row.
    const first = resvRef.headerRowNumber + 1;
    const last = resvRef.lastRow;
    const colLetter = (key) => String.fromCharCode(65 + RESV_COLUMNS.findIndex((c) => c.key === key));
    const range = (key) => `Reservations!${colLetter(key)}${first}:${colLetter(key)}${last}`;

    const rows = [
        ['Total Reservations', { formula: `COUNTA(${range('customerName')})` }],
        ['Total Guests', { formula: `SUM(${range('guestCount')})` }],
        ['Pending', { formula: `COUNTIF(${range('status')},"Pending")` }],
        ['Approved', { formula: `COUNTIF(${range('status')},"Approved")` }],
        ['Completed', { formula: `COUNTIF(${range('status')},"Completed")` }],
        ['Cancelled', { formula: `COUNTIF(${range('status')},"Cancelled")` }],
        ['Declined', { formula: `COUNTIF(${range('status')},"Declined")` }],
        ['Rescheduled', { formula: `COUNTIF(${range('status')},"Rescheduled")` }],
        ['Payments Collected', { formula: `SUM(${range('amountPaid')})` }]
    ];

    rows.forEach(([label, value]) => {
        const row = sheet.addRow([label, value]);
        row.getCell(1).font = REPORT_FONT;
        row.getCell(2).font = REPORT_FONT;
    });
    // "Payments Collected" is the last row added — give it currency formatting.
    sheet.getRow(sheet.rowCount).getCell(2).numFmt = CURRENCY_FORMAT;

    sheet.getColumn(1).width = 26;
    sheet.getColumn(2).width = 20;
    sheet.views = [{ state: 'frozen', ySplit: headerRowNumber }];
}

async function exportReportsExcel() {
    const filteredReservations = getFilteredReservations();
    if (!filteredReservations.length) {
        setReportsMessage('Add a date range or adjust the search so at least one reservation can be exported.', true);
        return;
    }

    const ExcelJSLib = window.ExcelJS;
    if (!ExcelJSLib) {
        setReportsMessage('Excel export is not available because the export library did not load.', true);
        return;
    }

    exportExcelBtn.disabled = true;
    const originalLabel = exportExcelBtn.innerHTML;
    exportExcelBtn.innerHTML = 'Generating…';

    try {
        const workbook = new ExcelJSLib.Workbook();
        workbook.creator = 'ELI Coffee Events';
        workbook.created = new Date();

     const resvRef = buildReservationsSheet(workbook, filteredReservations);
        buildSummarySheet(workbook, resvRef);

    const buffer = await workbook.xlsx.writeBuffer();
        const blob = new Blob([buffer], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        });

    const fromValue = reportDateFrom?.value || '';
        const toValue = reportDateTo?.value || '';
        const periodPart = fromValue || toValue
            ? `${fromValue || 'start'}_to_${toValue || 'now'}`
            : new Date().toISOString().slice(0, 10);
        const filename = `reservation-report_${periodPart}.xlsx`;

        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);

        setReportsMessage(`Exported ${filteredReservations.length} reservation(s) to Excel.`);
    } catch (error) {
        setReportsMessage("Couldn't generate the export — please try again.", true);
    } finally {
        exportExcelBtn.disabled = false;
        exportExcelBtn.innerHTML = originalLabel;
    }
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
    const { session, profile } = await verifyMultiRoleSession(supabase, ['manager', 'admin']);

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
    const roleBottomEl = document.getElementById('sidebarRoleBottom');
    if (roleBottomEl) roleBottomEl.textContent = profile.role === 'admin' ? 'Admin' : 'Manager';

    applyRoleVisibility(profile.role);
    initAdminNav({ role: profile.role });

    return session;
}

async function loadReports({ silent = false } = {}) {
    if (!silent) {
        setReportsMessage('Loading reservations...');
    }

    try {
        state.reservations = await fetchReservations();
        state.paymentSummaryMap = await fetchPaymentSummaries(
            state.reservations.map((r) => r.reservation_id).filter(Boolean)
        ).catch(() => ({}));
        renderReports({ resetPage: !silent });
        await refreshAdminSidebarCounts({
            supabase,
            reservationBadgeEl: navReservationCount,
            paymentBadgeEl: navPaymentCount,
            contractBadgeEl: navContractCount,
            reviewBadgeEl: navReviewCount
        }).catch(() => {});
    } catch (error) {
        if (silent) {
            console.warn('Auto-refresh failed, keeping last loaded reports data:', error.message);
            return;
        }
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

exportExcelBtn?.addEventListener('click', exportReportsExcel);
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
    initManagerNotificationBell(supabase, session.user.id);
    await loadReports();
}

let lastAutoRefreshAt = 0;
const AUTO_REFRESH_DEBOUNCE_MS = 3000;
const AUTO_REFRESH_POLL_MS = 60000;
    
function triggerAutoRefresh() {
    const now = Date.now();
    if (now - lastAutoRefreshAt < AUTO_REFRESH_DEBOUNCE_MS) return;
    lastAutoRefreshAt = now;
    loadReports({ silent: true });
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') triggerAutoRefresh();
});
window.addEventListener('focus', triggerAutoRefresh);
window.addEventListener('pageshow', (event) => {
    if (event.persisted) triggerAutoRefresh();
});
setInterval(triggerAutoRefresh, AUTO_REFRESH_POLL_MS);