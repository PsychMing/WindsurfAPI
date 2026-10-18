/**
 * Normalize the three app.devin.ai billing reads into one dashboard payload.
 *
 * Pure and defensive: the upstream shape is FastAPI JSON, but a missing field
 * must degrade to null rather than NaN or a thrown render error.
 */

function num(value, fallback = null) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value, fallback = null) {
  return typeof value === 'boolean' ? value : fallback;
}

function str(value) {
  return typeof value === 'string' && value ? value : null;
}

export function normalizeUsage({ quota, status, dailyUsage } = {}) {
  const q = quota && typeof quota === 'object' ? quota : {};
  const s = status && typeof status === 'object' ? status : {};
  const d = dailyUsage && typeof dailyUsage === 'object' ? dailyUsage : {};
  const days = Array.isArray(d.days)
    ? d.days.slice(0, 366).map((day) => ({
      date: str(day?.date),
      amount: num(day?.amount, 0),
      cumulative: num(day?.cumulative, 0),
    })).filter((day) => day.date)
    : [];

  return {
    plan: str(s.plan_slug),
    billingValid: bool(s.is_subscription_valid),
    billingMethod: str(s.billing_method),
    availableCredits: num(s.available_credits),
    overageCredits: num(s.overage_credits),
    quota: {
      isQuotaPlan: bool(q.is_quota_plan),
      hasAllocation: bool(q.has_quota_allocation),
      dailyPercentage: num(q.daily_percentage),
      weeklyPercentage: num(q.weekly_percentage),
      dailyResetAt: str(q.daily_reset_at),
      weeklyResetAt: str(q.weekly_reset_at),
      overageBalance: num(q.overage_balance),
      hideDailyQuota: bool(q.hide_daily_quota),
    },
    cycle: {
      start: str(d.cycle_start),
      end: str(d.cycle_end),
      previousAvailable: bool(d.previous_cycle_available),
      total: num(d.total, 0),
    },
    days,
  };
}
