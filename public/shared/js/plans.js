// ─── Subscription plans ─────────────────────────────────────────────────────
// Single source of truth for plan pricing/caps on the client. The Cloudflare
// Worker (cloudflare-worker/worker.js) mirrors this map server-side and never
// trusts a client-supplied amount — this file is for display + signup only.

const PLANS = {
  starter: { name: 'Starter', pricePaise: 59900,  studentCap: 30,   waNotifications: false },
  growth:  { name: 'Growth',  pricePaise: 149900, studentCap: 70,   waNotifications: true  },
  pro:     { name: 'Pro',     pricePaise: 399900, studentCap: null, waNotifications: true  },
};

const TRIAL_DAYS = 10;
const BILLING_PERIOD_DAYS = 30;
const REFERRAL_CREDIT_PAISE = 30000; // ₹300

function isValidPlan(plan) {
  return Object.prototype.hasOwnProperty.call(PLANS, plan);
}
