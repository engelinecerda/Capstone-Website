// Boundary checks for the notice-based cancellation / reschedule fees in
// js/reservation_shared.js (the database copies are cancellation_fee_for() and
// reschedule_fee_for() in 20261206_notice_based_cancellation_reschedule_fees.sql).
// Run with: node --experimental-strip-types supabase/functions/_shared/fee_policy_test.ts
import assert from 'node:assert/strict';
import { computeCancellationFee, computeRescheduleFee, getFeeTokenValues } from '../../../js/reservation_shared.js';

const today = '2026-12-01';
const res = (event_date: string, total_price = 10000) => ({ event_date, total_price });
const paid = [{ payment_type: 'down_payment', payment_status: 'approved', amount: 3000 }];

// Cancellation: fee only when LESS than 2 days remain and something was paid.
assert.equal(computeCancellationFee(res('2026-12-03'), {}, paid, today), 0, 'exactly 2 days is free');
assert.equal(computeCancellationFee(res('2026-12-02'), {}, paid, today), 3000, '1 day = full 30% of total');
assert.equal(computeCancellationFee(res('2026-12-01'), {}, paid, today), 3000, 'same day');
assert.equal(computeCancellationFee(res('2026-12-02'), {}, [], today), 0, 'nothing paid = no fee');
assert.equal(computeCancellationFee(res('2026-12-02', 12345.67), {}, paid, today), 3703.7, 'rounded to centavos');

// Reschedule: fee only when LESS than 30 days remain before the original date.
assert.equal(computeRescheduleFee(res('2026-12-31'), {}, today), 0, 'exactly 30 days is free');
assert.equal(computeRescheduleFee(res('2026-12-30'), {}, today), 1000, '29 days = 10% of total');

// Settings overrides and tokens.
const rules = { cancellation_fee_percent: 50, cancellation_fee_notice_days: 7 };
assert.equal(computeCancellationFee(res('2026-12-07'), rules, paid, today), 5000);
assert.equal(getFeeTokenValues({}).cancellation_fee, '30% of the total contract amount');
assert.equal(getFeeTokenValues({}).reschedule_fee, '10% of the total contract amount');
console.log('fee_policy_test: ok');
