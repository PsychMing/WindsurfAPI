import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage } from '../src/dashboard/usage.js';

describe('dashboard usage normalizer', () => {
  it('maps quota, plan, cycle and daily rows', () => {
    const out = normalizeUsage({
      quota: {
        is_quota_plan: true,
        has_quota_allocation: true,
        daily_percentage: 3,
        weekly_percentage: 1,
        daily_reset_at: '2026-10-18T00:00:00-08:00',
        weekly_reset_at: '2026-10-18T00:00:00-08:00',
        overage_balance: 0,
        hide_daily_quota: false,
      },
      status: {
        plan_slug: 'pro',
        is_subscription_valid: true,
        billing_method: 'stripe',
        available_credits: 0,
        overage_credits: 0,
      },
      dailyUsage: {
        cycle_start: '2026-10-16T20:11:50+00:00',
        cycle_end: '2026-11-16T20:11:50+00:00',
        previous_cycle_available: false,
        total: 0,
        days: [
          { date: '2026-10-16', amount: 0, cumulative: 0 },
          { date: '2026-10-17', amount: 1.5, cumulative: 1.5 },
        ],
      },
    });
    assert.equal(out.plan, 'pro');
    assert.equal(out.billingValid, true);
    assert.equal(out.quota.dailyPercentage, 3);
    assert.equal(out.quota.weeklyPercentage, 1);
    assert.equal(out.cycle.total, 0);
    assert.deepEqual(out.days, [
      { date: '2026-10-16', amount: 0, cumulative: 0 },
      { date: '2026-10-17', amount: 1.5, cumulative: 1.5 },
    ]);
  });

  it('degrades malformed/missing fields to null instead of NaN', () => {
    const out = normalizeUsage({
      quota: { daily_percentage: '3', overage_balance: NaN },
      status: null,
      dailyUsage: { days: [{ amount: 'x' }, null, { date: '2026-10-18', amount: 2 }] },
    });
    assert.equal(out.plan, null);
    assert.equal(out.availableCredits, null);
    assert.equal(out.quota.dailyPercentage, null);
    assert.equal(out.quota.overageBalance, null);
    assert.deepEqual(out.days, [{ date: '2026-10-18', amount: 2, cumulative: 0 }]);
  });

  it('caps daily rows at 366', () => {
    const days = Array.from({ length: 400 }, (_, i) => ({ date: `d${i}`, amount: 1, cumulative: 1 }));
    const out = normalizeUsage({ dailyUsage: { days } });
    assert.equal(out.days.length, 366);
  });
});
