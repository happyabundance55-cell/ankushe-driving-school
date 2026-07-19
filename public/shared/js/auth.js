// ─── Auth: real Firebase Auth ───────────────────────────────────────────────
// Admin: Google Sign-in. Mentor/Student: Phone OTP. Replaces the old fake
// `_session` localStorage blob entirely — session state now lives in
// firebase.auth() itself, and role/tenant come from the users/{uid} doc,
// read fresh (and checked against security rules) on every requireAuth() call.

function initFirebase() {
  if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
  return { db: firebase.firestore() };
}

function _waitForAuthState() {
  return new Promise(resolve => {
    const unsub = firebase.auth().onAuthStateChanged(user => { unsub(); resolve(user); });
  });
}

const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;

// Reads this signed-in user's app profile (role/tenantId/...) from users/{uid}.
// Returns null if not signed in, or signed in but not yet linked to any role.
// The Firestore read is cached per-uid for a few minutes purely to avoid
// re-fetching it on every full-page navigation (this is a multi-page app, not
// an SPA) — it's a speed cache, not a trust boundary: actual data access is
// still enforced by security rules reading the real users/{uid} doc server-side,
// so a stale or even tampered cache here can't grant access to anything.
async function getCurrentUser() {
  const user = await _waitForAuthState();
  if (!user) return null;

  const cacheKey = 'sarathi_profile_' + user.uid;
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) {
    try {
      const { cachedAt, data } = JSON.parse(cached);
      if (Date.now() - cachedAt < PROFILE_CACHE_TTL_MS) return { uid: user.uid, ...data };
    } catch { /* fall through to network */ }
  }

  const snap = await firebase.firestore().collection('users').doc(user.uid).get();
  if (!snap.exists) return null;
  const data = snap.data();
  // createdAt/joiningDate are Firestore Timestamps — don't survive JSON
  // round-trips as usable Timestamp instances, so exclude them from the cache.
  const { createdAt, joiningDate, ...cacheable } = data;
  sessionStorage.setItem(cacheKey, JSON.stringify({ cachedAt: Date.now(), data: cacheable }));
  return { uid: user.uid, ...data };
}

// Resolves the tenant from the URL, verifies the signed-in user belongs to
// it (and has an allowed role), or redirects to this tenant's login page.
async function requireAuth(allowedRoles) {
  initFirebase();
  // Independent lookups (tenant resolution doesn't depend on auth state, and
  // vice versa) — run them in parallel instead of stacking their latency.
  const [tenant, profile] = await Promise.all([resolveTenant(), getCurrentUser()]);

  if (!profile || profile.tenantId !== tenant.id) {
    window.location.href = tenantUrl('/login.html');
    return new Promise(() => {});
  }
  if (allowedRoles && !allowedRoles.includes(profile.role)) {
    window.location.href = tenantUrl('/login.html');
    return new Promise(() => {});
  }
  return { user: profile, profile };
}

// Convenience for the top of every protected page: resolves the tenant,
// enforces auth+role, and applies branding, in one call.
//
// On failure (missing ?t= slug, unknown school, missing script include,
// etc.), shows a visible on-page error instead of leaving the page's loading
// spinner stuck forever with no explanation — that silent-hang failure mode
// has bitten this app more than once (missing Auth SDK script, missing
// tenant slug in a shared link), so the safety net lives here once, centrally,
// rather than needing every one of ~20 pages to handle it individually.
async function bootstrapPage(roles) {
  try {
    const { user, profile } = await requireAuth(roles);
    applyBranding(getTenant());
    preserveTenantLinks(getTenant());
    await enforceBilling(profile, getTenant().id);
    return { user, profile, tenant: getTenant() };
  } catch (e) {
    if (!(e instanceof BillingExpiredError)) _showBootstrapError(e);
    throw e;
  }
}

// ─── Billing gate ────────────────────────────────────────────────────────────
// Trial/subscription enforcement. billingStatus/trialEndsAt/currentPeriodEnd
// on tenants/{tid} are written only by the Cloudflare Worker (after a
// verified Cashfree payment) or a superadmin — never by the tenant admin's
// own client (see firestore.rules billingKeysUnchanged()) — so this check
// can't be defeated by a school editing its own tenant doc.
//
// Reads the tenant doc fresh (not the branding/name cache in tenant.js,
// whose sessionStorage round-trip drops Timestamp fields) so the gate is
// never stale by more than one page load.

const BILLING_REMINDER_DAYS = 3;

class BillingExpiredError extends Error {}

function _billingState(billing) {
  const now = Date.now();
  const trialEndsAtMs = billing.trialEndsAt ? billing.trialEndsAt.toMillis() : null;
  const periodEndMs   = billing.currentPeriodEnd ? billing.currentPeriodEnd.toMillis() : null;

  let expired = billing.billingStatus === 'expired';
  if (billing.billingStatus === 'trialing' && trialEndsAtMs != null && now > trialEndsAtMs) expired = true;
  if (billing.billingStatus === 'active' && periodEndMs != null && now > periodEndMs) expired = true;

  const deadlineMs = billing.billingStatus === 'trialing' ? trialEndsAtMs : periodEndMs;
  const daysLeft = (!expired && deadlineMs != null) ? Math.ceil((deadlineMs - now) / 86400000) : null;

  return { expired, daysLeft };
}

async function enforceBilling(profile, tenantId) {
  const snap = await getDb().collection('tenants').doc(tenantId).get();
  const billing = snap.data() || {};
  const { expired, daysLeft } = _billingState(billing);

  if (expired) {
    if (profile.role === 'admin') {
      if (!window.location.pathname.endsWith('/admin/billing.html')) {
        window.location.href = tenantUrl('/admin/billing.html');
        throw new BillingExpiredError('Redirecting to billing.');
      }
      return; // already on the billing/renew page — let it render normally
    }
    _showExpiredOverlay();
    throw new BillingExpiredError('Subscription expired.');
  }

  if (profile.role === 'admin' && daysLeft != null && daysLeft <= BILLING_REMINDER_DAYS) {
    const flagKey = 'sarathi_billing_reminder_' + tenantId + '_' + new Date().toDateString();
    if (!sessionStorage.getItem(flagKey)) {
      sessionStorage.setItem(flagKey, '1');
      const what = billing.billingStatus === 'trialing' ? 'trial' : 'plan';
      const msg = daysLeft <= 0
        ? `Your ${what} ends today — renew any time from Billing.`
        : `Your ${what} ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'} — renew any time from Billing.`;
      showToast(msg, 'info');
    }
  }
}

function _showExpiredOverlay() {
  if (document.getElementById('billing-expired-overlay')) return;
  const el = document.createElement('div');
  el.id = 'billing-expired-overlay';
  el.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.75);' +
    'display:flex;align-items:center;justify-content:center;padding:1.5rem;text-align:center';
  el.innerHTML = '<div style="background:var(--card-bg,#fff);color:var(--text,#111);padding:2rem;' +
    'border-radius:12px;max-width:360px;font:1rem/1.5 system-ui,sans-serif">' +
    '<h2 style="margin:0 0 .5rem">Subscription expired</h2>' +
    '<p style="margin:0">This school’s Sarathi subscription has expired. Ask your school admin to renew to continue.</p></div>';
  document.body.appendChild(el);
}

function _showBootstrapError(e) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#7f1d1d;color:#fff;' +
    'padding:.75rem 1.25rem;font:600 .85rem/1.4 system-ui,sans-serif;text-align:center';
  el.textContent = 'This page couldn\'t load: ' + (e && e.message ? e.message : 'unknown error') +
    '. If you followed a bookmarked link, make sure it includes your school (?t=your-school-id).';
  document.body.prepend(el);
}

function logout() {
  firebase.auth().signOut().then(() => {
    window.location.href = tenantUrl('/login.html');
  });
}

// ─── Google Sign-in (admin) ─────────────────────────────────────────────────

async function signInWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  const result = await firebase.auth().signInWithPopup(provider);
  return result.user;
}

// ─── Phone OTP (mentor / student) ───────────────────────────────────────────

let _recaptchaVerifier = null;

function getRecaptchaVerifier(containerId) {
  if (!_recaptchaVerifier) {
    _recaptchaVerifier = new firebase.auth.RecaptchaVerifier(containerId, { size: 'invisible' }, firebase.app());
  }
  return _recaptchaVerifier;
}

// phoneE164 must include country code, e.g. "+919876543210".
async function startPhoneSignIn(phoneE164, recaptchaContainerId) {
  const verifier = getRecaptchaVerifier(recaptchaContainerId);
  return firebase.auth().signInWithPhoneNumber(phoneE164, verifier);
}

async function confirmPhoneOtp(confirmationResult, code) {
  const result = await confirmationResult.confirm(code);
  return result.user;
}

// ─── Post-OTP identity resolution ───────────────────────────────────────────
// Called right after a successful phone sign-in, before any users/{uid} doc
// exists for this UID, to figure out what this phone number is allowed to
// become in the current tenant.
//
// Returns one of:
//   { kind: 'existing',    profile }                — already linked, just log in
//   { kind: 'link-student', studentId }              — admin already enrolled this phone
//   { kind: 'link-mentor',  name }                   — admin invited this phone as mentor
//   { kind: 'new-student' }                          — no record anywhere; self-serve signup

async function resolvePhoneIdentity(uid, phoneE164) {
  const db = firebase.firestore();
  const tenant = getTenant();

  const existing = await db.collection('users').doc(uid).get();
  if (existing.exists) return { kind: 'existing', profile: { uid, ...existing.data() } };

  const studentMap = await db.collection('tenants').doc(tenant.id)
    .collection('studentsByPhone').doc(phoneE164).get();
  if (studentMap.exists) {
    return { kind: 'link-student', studentId: studentMap.data().studentId };
  }

  const invite = await db.collection('pendingInvites').doc(phoneE164).get();
  if (invite.exists && invite.data().tenantId === tenant.id && invite.data().role === 'mentor') {
    return { kind: 'link-mentor', name: invite.data().name, joiningDate: invite.data().joiningDate };
  }

  return { kind: 'new-student' };
}

async function linkExistingStudent(uid, phoneE164, studentId) {
  await firebase.firestore().collection('users').doc(uid).set({
    tenantId: getTenant().id,
    role: 'student',
    studentId,
    phone: phoneE164,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

async function linkMentorInvite(uid, phoneE164, name, joiningDate) {
  const db = firebase.firestore();
  const batch = db.batch();
  batch.set(db.collection('users').doc(uid), {
    tenantId: getTenant().id,
    role: 'mentor',
    name,
    phone: phoneE164,
    status: 'active',
    joiningDate: joiningDate || firebase.firestore.Timestamp.now(),
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  batch.delete(db.collection('pendingInvites').doc(phoneE164));
  await batch.commit();
}

// Self-serve signup for a phone with no existing record anywhere. Mirrors the
// original app's behavior: enrollment number stays blank until an admin
// formally processes the enrollment later — the counter is staff-only by
// rule, so a fresh anonymous signup deliberately can't touch it.
//
// Created as status 'pending', not 'active' — a self-created profile isn't
// a real student until the school approves it (students.html's Approve
// action flips this to 'active' and assigns the enrollment number). This
// keeps unapproved signups out of the school's normal active roster and
// off any status:'active' filtered query.
async function createNewStudentSignup(uid, phoneE164, { name, address, dob }) {
  const db     = firebase.firestore();
  const tenant = getTenant();

  if (tenant.studentCap != null) {
    const countSnap = await db.collection('tenants').doc(tenant.id).collection('students').count().get();
    if (countSnap.data().count >= tenant.studentCap) {
      throw new Error('This school has reached its student limit. Contact the school directly to enroll.');
    }
  }

  const studentRef = db.collection('tenants').doc(tenant.id).collection('students').doc();

  const batch = db.batch();
  batch.set(studentRef, {
    name, phone: phoneE164, address: address || '', dob: dob || '',
    enrollmentNumber: '', enrollmentDate: firebase.firestore.Timestamp.now(),
    photoURL: '', photoPublicId: '',
    totalFee: 0, paidFee: 0, balance: 0,
    referredBy: null, referralApplied: false, status: 'pending',
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  batch.set(db.collection('tenants').doc(tenant.id).collection('studentsByPhone').doc(phoneE164), {
    studentId: studentRef.id
  });
  batch.set(db.collection('users').doc(uid), {
    tenantId: tenant.id, role: 'student', studentId: studentRef.id, phone: phoneE164, name,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  await batch.commit();
  return studentRef.id;
}
