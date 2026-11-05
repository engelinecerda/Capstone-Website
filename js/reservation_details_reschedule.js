// Reschedule modal for the reservation details page.
//
// "Request reschedule" used to link out to /account?section=reservations&open=
// reschedule, which dropped the customer onto the My reservations list with
// the modal over it. This builds the same modal (same markup ids/classes as
// account.html, same account.css styling) directly on reservation-details.html
// so the customer stays on the reservation. The calendar / time-slot / submit
// logic mirrors js/account.js's reschedule modal — keep the two in step.
import {
    fetchAvailableStartTimes,
    fetchBlackoutDates,
    fetchCalendarAvailability,
    getBookingScope as getSharedBookingScope,
    getCalendarRange,
    getScopeLabel,
    loadAdvanceNoticeRules,
    getEffectiveMinAdvanceDays,
    isOutsideBookingWindow
} from './reservation_availability.js';
import { escapeHtml, formatDate, formatDateKey, getRescheduleFee } from './reservation_shared.js';
import { renderPolicyText } from './policy_text.js';
import { lockBodyScroll, unlockBodyScroll } from './modal_scroll_lock.js';

function getBookingScope(reservation) {
    return getSharedBookingScope(
        reservation?.location_type,
        reservation?.package?.package_name || reservation?.package_name || ''
    );
}

function getReservationDurationHours(reservation) {
    const packageDuration = Number(reservation?.package?.duration_hours || 0);
    if (packageDuration > 0) return packageDuration;

    const packageName = String(reservation?.package?.package_name || '').toLowerCase();
    if (packageName.includes('vip lite')) return 2;
    if (packageName.includes('vip plus')) return 3;
    if (packageName.includes('vip max')) return 4;
    if (packageName.includes('main hall basic')) return 2;
    if (packageName.includes('main hall plus')) return 3;
    if (packageName.includes('catering')) return 4;
    return 3;
}

/**
 * @param {object} options
 * @param {object} options.supabase
 * @param {object} options.user        signed-in auth user (for the request's user_id)
 * @param {() => object|null} options.getPageData  returns the details page's current data
 *        ({ reservation, paymentRules, policyBodies, ... })
 * @param {() => Promise<void>} options.onSubmitted  called after the request is saved,
 *        so the page can reload and show the new reschedule request
 * @returns {{ open: () => Promise<void> }}
 */
export function initRescheduleModal({ supabase, user, getPageData, onSubmitted }) {
    const backdrop = document.getElementById('reschedule-modal-backdrop');
    if (!backdrop) return { open: async () => {} };

    const closeBtn = document.getElementById('reschedule-modal-close');
    const cancelBtn = document.getElementById('reschedule-modal-cancel');
    const submitBtn = document.getElementById('reschedule-modal-submit');
    const messageEl = document.getElementById('reschedule-modal-message');
    const currentValueEl = document.getElementById('reschedule-current-value');
    const feeAmountEl = document.getElementById('reschedule-fee-amount');
    const prevMonthBtn = document.getElementById('reschedule-prev-month');
    const nextMonthBtn = document.getElementById('reschedule-next-month');
    const monthLabel = document.getElementById('reschedule-month-label');
    const calendarGrid = document.getElementById('reschedule-calendar-grid');
    const timeGrid = document.getElementById('reschedule-time-grid');

    const state = {
        open: false,
        month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
        selectedDate: '',
        selectedTime: '',
        calendarAvailability: new Map(),
        availableStartTimes: [],
        advanceNoticeRules: null,
        closedDates: new Set(),
        // Dates that passed the calendar's capacity check but turned out to have
        // no bookable start time (hours / buffer / duration), learned when tried.
        noSlotDates: new Set(),
        blackoutDateColumn: null,
        blackoutReasonColumn: null
    };

    // Dates whose open start times have already been looked up this session, and a
    // token that lets a newer scan (month change / reopen) cancel an older one.
    const slotCheckedDates = new Set();
    let slotScanToken = 0;
    const SLOT_SCAN_CONCURRENCY = 5;

    const getReservation = () => getPageData()?.reservation || null;

    function setMessage(message, isError = false) {
        if (!messageEl) return;
        messageEl.textContent = message || '';
        messageEl.classList.toggle('error', isError);
    }

    function getEffectiveMinAdvanceDaysForReservation(reservation) {
        return getEffectiveMinAdvanceDays(state.advanceNoticeRules, reservation?.event_type);
    }

    function applyPolicyOverride() {
        const el = document.getElementById('reschedule-policy-body');
        const body = getPageData()?.policyBodies?.reschedule_policy;
        if (el && body) el.innerHTML = renderPolicyText(body);
    }

    async function loadAvailability(reservation) {
        const month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        const range = getCalendarRange(month);
        const [blackoutData, calendarAvailability, advanceNoticeRules] = await Promise.all([
            fetchBlackoutDates(supabase, state),
            fetchCalendarAvailability(supabase, { fromDate: range.fromDate, toDate: range.toDate }),
            loadAdvanceNoticeRules(supabase)
        ]);

        state.closedDates = blackoutData.closedDates;
        state.blackoutDateColumn = blackoutData.blackoutDateColumn;
        state.blackoutReasonColumn = blackoutData.blackoutReasonColumn;
        state.calendarAvailability = calendarAvailability;
        state.advanceNoticeRules = advanceNoticeRules;
        state.month = month;
        state.selectedDate = '';
        state.selectedTime = reservation.event_time || '';
        state.availableStartTimes = [];
        state.noSlotDates = new Set();
        slotCheckedDates.clear();
        slotScanToken += 1;
    }

    async function loadCalendarMonth() {
        const range = getCalendarRange(state.month);
        state.calendarAvailability = await fetchCalendarAvailability(supabase, {
            fromDate: range.fromDate,
            toDate: range.toDate
        });
    }

    // Live per-slot availability (operating hours + buffer + capacity) from the
    // same RPC the booking form uses.
    async function loadSelectedDateAvailability(reservation) {
        if (!state.selectedDate) {
            state.availableStartTimes = [];
            return [];
        }

        const rows = await fetchAvailableStartTimes(supabase, {
            eventDate: state.selectedDate,
            scope: getBookingScope(reservation),
            durationHours: getReservationDurationHours(reservation),
            excludeReservationId: reservation.reservation_id
        });
        state.availableStartTimes = rows;
        return rows;
    }

    function isDateFullyBooked() {
        const rows = state.availableStartTimes || [];
        return rows.length === 0 || rows.every((row) => !row.isAvailable);
    }

    function renderTimes() {
        if (!timeGrid) return;

        const selectedTime = state.selectedTime;
        const rows = state.availableStartTimes || [];

        if (!state.selectedDate) {
            timeGrid.innerHTML = '';
            return;
        }

        if (!rows.length) {
            timeGrid.innerHTML = '<p class="reschedule-time-empty">No valid start times for this date within operating hours.</p>';
            return;
        }

        timeGrid.innerHTML = rows.map((row) => `
            <button
                type="button"
                class="reschedule-time-btn ${selectedTime === row.timeLabel ? 'active' : ''} ${!row.isAvailable ? 'disabled' : ''}"
                data-time="${escapeHtml(row.timeLabel)}"
                title="${escapeHtml(row.isAvailable ? `Choose ${row.timeLabel} as your new start time.` : (row.reason || 'Unavailable at this time.'))}"
                ${!row.isAvailable ? 'disabled' : ''}
            >
                ${escapeHtml(row.timeLabel)}
            </button>
        `).join('');
    }

    // One place that decides what state a calendar day is in, so rendering and the
    // background "no open times" scan can never disagree about which days are open.
    function getDayFlags(date, dateKey, reservation, today) {
        // date < today (not <=) so "today" is excluded only via the notice
        // window below, same as the booking form's calendar.
        const isPast = date < today;
        const isClosed = state.closedDates.has(dateKey);
        const isOutsideWindow = !isPast && isOutsideBookingWindow(
            date, today, state.advanceNoticeRules, reservation.event_type
        );
        const dateAvailability = state.calendarAvailability.get(dateKey) || {
            occupiedScopes: [],
            isFullyBooked: false
        };
        const isBooked = dateAvailability.isFullyBooked || state.noSlotDates.has(dateKey);
        const isCurrent = formatDateKey(reservation.event_date) === dateKey;
        const isAvailable = !isPast && !isClosed && !isOutsideWindow && !isBooked && !isCurrent;
        return { isPast, isClosed, isOutsideWindow, isBooked, isCurrent, isAvailable };
    }

    // The calendar RPC only knows whether a day has spare capacity; it can't see
    // that every start time is taken (operating hours, buffer, event length). So
    // after the month draws, look up the open times for each day that still looks
    // available and grey out the ones with none — customers shouldn't have to
    // click a day to discover it is booked out.
    async function scanMonthForNoSlotDays() {
        const reservation = getReservation();
        if (!reservation) return;

        const token = ++slotScanToken;
        const month = state.month;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();

        const queue = [];
        for (let day = 1; day <= daysInMonth; day += 1) {
            const date = new Date(month.getFullYear(), month.getMonth(), day);
            const dateKey = [
                date.getFullYear(),
                String(date.getMonth() + 1).padStart(2, '0'),
                String(date.getDate()).padStart(2, '0')
            ].join('-');
            if (slotCheckedDates.has(dateKey) || dateKey === state.selectedDate) continue;
            if (getDayFlags(date, dateKey, reservation, today).isAvailable) queue.push(dateKey);
        }
        if (!queue.length) return;

        const scope = getBookingScope(reservation);
        const durationHours = getReservationDurationHours(reservation);

        async function worker() {
            while (queue.length) {
                if (token !== slotScanToken || !state.open) return;
                const dateKey = queue.shift();
                try {
                    const rows = await fetchAvailableStartTimes(supabase, {
                        eventDate: dateKey,
                        scope,
                        durationHours,
                        excludeReservationId: reservation.reservation_id
                    });
                    if (token !== slotScanToken || !state.open) return;
                    slotCheckedDates.add(dateKey);
                    if (rows.length === 0 || rows.every((row) => !row.isAvailable)) {
                        state.noSlotDates.add(dateKey);
                        renderCalendar();
                    }
                } catch (_) {
                    // A failed lookup just leaves the day as it was; clicking it
                    // still re-checks (and greys it out if it turns out to be full).
                }
            }
        }

        await Promise.all(Array.from({ length: SLOT_SCAN_CONCURRENCY }, worker));
    }

    function renderCalendar() {
        if (!calendarGrid || !monthLabel) return;

        const reservation = getReservation();
        if (!reservation) return;

        const month = state.month;
        const start = new Date(month.getFullYear(), month.getMonth(), 1);
        const end = new Date(month.getFullYear(), month.getMonth() + 1, 0);
        const firstWeekday = start.getDay();
        const daysInMonth = end.getDate();
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        monthLabel.textContent = month.toLocaleDateString('en-PH', { year: 'numeric', month: 'long' });

        const cells = [];
        for (let index = 0; index < firstWeekday; index += 1) {
            cells.push('<div class="reschedule-empty-day"></div>');
        }

        for (let day = 1; day <= daysInMonth; day += 1) {
            const date = new Date(month.getFullYear(), month.getMonth(), day);
            const dateKey = [
                date.getFullYear(),
                String(date.getMonth() + 1).padStart(2, '0'),
                String(date.getDate()).padStart(2, '0')
            ].join('-');
            const { isPast, isClosed, isOutsideWindow, isBooked, isCurrent, isAvailable } = getDayFlags(date, dateKey, reservation, today);
            const isSelected = state.selectedDate === dateKey;
            const classNames = ['reschedule-day'];
            let label = 'Unavailable';

            if (isAvailable) {
                classNames.push('available');
                label = 'Available';
            } else if (isClosed) {
                classNames.push('closed');
                label = 'Closed';
            } else if (isBooked) {
                classNames.push('booked');
                label = 'This date is fully booked.';
            } else if (isCurrent) {
                // Checked before isOutsideWindow/isPast: the reservation's own
                // date isn't a "too soon" date for a *new* booking.
                classNames.push('disabled');
                label = 'Current booking date';
            } else if (isOutsideWindow) {
                classNames.push('past');
                const effectiveMinDays = getEffectiveMinAdvanceDaysForReservation(reservation);
                const diffDays = Math.round((date - today) / 86400000);
                label = diffDays < effectiveMinDays
                    ? `Too soon to book — needs at least ${effectiveMinDays} day(s) notice.`
                    : 'Too far in advance to book.';
            } else if (isPast) {
                classNames.push('past');
                label = 'This date has already passed.';
            } else {
                classNames.push('disabled');
                label = 'Unavailable';
            }

            if (isCurrent) classNames.push('current');
            if (isSelected) classNames.push('selected');

            cells.push(`
                <button
                    type="button"
                    class="${classNames.join(' ')}"
                    data-date="${escapeHtml(dateKey)}"
                    aria-label="${escapeHtml(label)} on ${escapeHtml(formatDate(dateKey))}"
                    ${isAvailable ? '' : 'disabled'}
                >
                    <span>${day}</span>
                </button>
            `);
        }

        calendarGrid.innerHTML = cells.join('');
    }

    function close() {
        state.open = false;
        state.selectedDate = '';
        state.selectedTime = '';
        state.calendarAvailability = new Map();
        state.availableStartTimes = [];
        state.closedDates = new Set();
        state.noSlotDates = new Set();
        slotCheckedDates.clear();
        slotScanToken += 1;
        backdrop.classList.add('hidden');
        backdrop.setAttribute('aria-hidden', 'true');
        submitBtn?.removeAttribute('disabled');
        setMessage('');
        unlockBodyScroll();
    }

    async function open() {
        const reservation = getReservation();
        if (!reservation) return;

        state.open = true;
        if (currentValueEl) {
            currentValueEl.textContent = `${formatDate(reservation.event_date)} at ${reservation.event_time || 'No time selected'}`;
        }
        if (feeAmountEl) feeAmountEl.textContent = `₱${getRescheduleFee(getPageData()?.paymentRules).toLocaleString()}`;
        applyPolicyOverride();

        setMessage('Loading availability...');
        backdrop.classList.remove('hidden');
        backdrop.setAttribute('aria-hidden', 'false');
        lockBodyScroll();

        try {
            await loadAvailability(reservation);
            renderCalendar();
            renderTimes();
            setMessage(`Choose a future available date for the ${getScopeLabel(getBookingScope(reservation))} booking slot, then select your new start time.`);
            scanMonthForNoSlotDays();
        } catch (error) {
            setMessage(`Failed to load availability: ${error.message}`, true);
        }
    }

    async function submit() {
        const reservation = getReservation();
        if (!reservation) return;

        if (!state.selectedDate) {
            setMessage('Please choose a new available date first.', true);
            return;
        }

        if (!state.selectedTime) {
            setMessage('Please choose a new event time.', true);
            return;
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const selectedDateObj = new Date(`${state.selectedDate}T00:00:00`);
        if (isOutsideBookingWindow(selectedDateObj, today, state.advanceNoticeRules, reservation.event_type)) {
            const effectiveMinDays = getEffectiveMinAdvanceDaysForReservation(reservation);
            const diffDays = Math.round((selectedDateObj - today) / 86400000);
            setMessage(
                diffDays < effectiveMinDays
                    ? `This date is too soon — please choose a date at least ${effectiveMinDays} day(s) from today.`
                    : 'This date is too far in advance — please choose a closer date.',
                true
            );
            return;
        }

        submitBtn?.setAttribute('disabled', 'true');
        setMessage('Submitting your reschedule request...');

        try {
            // Re-check the specific date + time right before submitting, so a
            // second customer can't win the slot between open and submit.
            const rows = await loadSelectedDateAvailability(reservation);
            const selectedRow = rows.find((row) => row.timeLabel === state.selectedTime);
            if (!selectedRow?.isAvailable) {
                state.selectedTime = '';
                renderTimes();
                throw new Error(selectedRow?.reason || 'That time is no longer available. Please choose another.');
            }

            // No manager approval step: it goes straight to awaiting-fee, and the
            // manager's only remaining touchpoint is verifying the fee payment.
            const payload = {
                reservation_id: reservation.reservation_id,
                user_id: user.id,
                original_date: reservation.event_date,
                original_time: reservation.event_time,
                requested_date: state.selectedDate,
                requested_time: state.selectedTime,
                status: 'approved_pending_payment'
            };

            const { error } = await supabase
                .from('reschedule_requests')
                .insert(payload);

            if (error) throw error;

            close();
            await onSubmitted?.();
        } catch (error) {
            submitBtn?.removeAttribute('disabled');
            setMessage(`Failed to submit request: ${error.message}`, true);
        }
    }

    closeBtn?.addEventListener('click', close);
    cancelBtn?.addEventListener('click', close);
    submitBtn?.addEventListener('click', submit);
    backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) close();
    });

    prevMonthBtn?.addEventListener('click', async () => {
        if (!state.open) return;
        state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1);
        await loadCalendarMonth();
        renderCalendar();
        scanMonthForNoSlotDays();
    });

    nextMonthBtn?.addEventListener('click', async () => {
        if (!state.open) return;
        state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1);
        await loadCalendarMonth();
        renderCalendar();
        scanMonthForNoSlotDays();
    });

    calendarGrid?.addEventListener('click', async (event) => {
        const dayButton = event.target.closest('.reschedule-day.available');
        if (!dayButton) return;
        const reservation = getReservation();
        if (!reservation) return;
        state.selectedDate = dayButton.dataset.date || '';
        state.selectedTime = '';
        await loadSelectedDateAvailability(reservation);
        // No open start time means the day is effectively booked out even though
        // the calendar's capacity check let it through — mark it so it shows as
        // booked (not "Available") and can't be picked again.
        if (isDateFullyBooked()) {
            state.noSlotDates.add(state.selectedDate);
            state.selectedDate = '';
            state.selectedTime = '';
            state.availableStartTimes = [];
            renderCalendar();
            renderTimes();
            setMessage('This date is fully booked — no start times are open. Please pick another date.', true);
            return;
        }
        // Don't carry the old time over: capacity, buffer or hours can differ
        // on the new date, so the customer picks fresh from what's open.
        renderCalendar();
        renderTimes();
        setMessage(`Selected ${formatDate(state.selectedDate)} for your ${getScopeLabel(getBookingScope(reservation))} booking slot.`);
    });

    timeGrid?.addEventListener('click', (event) => {
        const timeButton = event.target.closest('.reschedule-time-btn');
        if (!timeButton) return;
        if (timeButton.hasAttribute('disabled')) return;
        state.selectedTime = timeButton.dataset.time || '';
        renderTimes();
    });

    return { open };
}
