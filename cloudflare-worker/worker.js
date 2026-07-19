// ─── Sarathi subscription billing — Cashfree + Firestore ──────────────────────
// Independent Cloudflare Worker (separate deploy/secrets from Healthyabundance's
// cloudflare-worker/ — only the Cashfree merchant account is shared, copied into
// this worker's own secret store; nothing here touches the other project).
//
// Firestore is reached via the REST API, authenticated with a service-account
// OAuth2 token (signed with Web Crypto — the edge runtime can't run the Node
// firebase-admin SDK). Service-account credentials bypass Firestore Security
// Rules the same way firebase-admin does — this is what lets the Worker write
// tenants/{tid}.billingStatus, which firestore.rules blocks for every client
// (see billingKeysUnchanged() there): the Worker is the one trusted writer,
// and it only writes after Cashfree itself confirms PAID.

const PLANS = {
  starter: { pricePaise: 59900,  studentCap: 30,   waNotifications: false },
  growth:  { pricePaise: 149900, studentCap: 70,   waNotifications: true  },
  pro:     { pricePaise: 399900, studentCap: null, waNotifications: true  },
};

const FIRESTORE_PROJECT_ID = 'sarathi-driving-school';
const BILLING_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const REFERRAL_CREDIT_PAISE = 30000; // ₹300

// ─── Google service-account auth ───────────────────────────────────────────────

let _cachedToken = null; // { token, expiresAt } — reused across requests within a warm isolate

function base64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function getAccessToken(env) {
  if (_cachedToken && _cachedToken.expiresAt > Date.now() + 60000) return _cachedToken.token;

  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = unsigned + '.' + base64url(sig);

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error('Firebase auth failed: ' + JSON.stringify(data));

  _cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return _cachedToken.token;
}

// ─── Firestore REST helpers (flat-field docs only — enough for this app) ──────

function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  return { stringValue: String(v) };
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFirestoreValue(v);
  return fields;
}

function fromFirestoreValue(v) {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.nullValue !== undefined) return null;
  return null;
}

function fromFirestoreDoc(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc.fields || {})) out[k] = fromFirestoreValue(v);
  return out;
}

const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents`;

async function firestoreGet(env, path) {
  const token = await getAccessToken(env);
  const resp = await fetch(`${FS_BASE}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error('Firestore GET failed: ' + await resp.text());
  return fromFirestoreDoc(await resp.json());
}

async function firestorePatch(env, path, fields) {
  const token = await getAccessToken(env);
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const resp = await fetch(`${FS_BASE}/${path}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFirestoreFields(fields) }),
  });
  if (!resp.ok) throw new Error('Firestore PATCH failed: ' + await resp.text());
}

// "Create" a doc at an exact path only if it doesn't already exist — the
// currentDocument.exists=false precondition makes this the idempotency guard
// for order settlement (a repeated /order-status poll for an already-settled
// order becomes a safe no-op instead of double-crediting anything).
async function firestoreCreateIfAbsent(env, path, fields) {
  const token = await getAccessToken(env);
  const resp = await fetch(`${FS_BASE}/${path}?currentDocument.exists=false`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFirestoreFields(fields) }),
  });
  if (resp.status === 400 || resp.status === 409) return false; // already exists
  if (!resp.ok) throw new Error('Firestore create failed: ' + await resp.text());
  return true;
}

async function firestoreAddDoc(env, collectionPath, fields) {
  const token = await getAccessToken(env);
  const resp = await fetch(`${FS_BASE}/${collectionPath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFirestoreFields(fields) }),
  });
  if (!resp.ok) throw new Error('Firestore add failed: ' + await resp.text());
}

// ─── Cashfree ───────────────────────────────────────────────────────────────────

function cashfreeHeaders(env) {
  return {
    'Content-Type': 'application/json',
    'x-api-version': '2023-08-01',
    'x-client-id': env.CF_APP_ID,
    'x-client-secret': env.CF_SECRET_KEY,
  };
}

// ─── Handlers ───────────────────────────────────────────────────────────────────

// POST /create-order  {tenantId, plan, phone, name} -> {payment_session_id, order_id}
async function handleCreateOrder(req, env) {
  const { tenantId, plan, phone, name } = await req.json();
  if (!tenantId || !PLANS[plan]) return json({ error: 'Invalid tenantId/plan' }, 400);
  if (!/^\d{10}$/.test(phone || '')) return json({ error: 'Invalid phone' }, 400);

  const amountRupees = PLANS[plan].pricePaise / 100;
  const orderId = `sarathi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Recorded so /order-status can recover {tenantId, plan} from just the
  // orderId — never trust Cashfree to round-trip custom metadata reliably.
  await firestoreCreateIfAbsent(env, `pendingOrders/${orderId}`, {
    tenantId, plan, createdAt: new Date(),
  });

  const resp = await fetch('https://api.cashfree.com/pg/orders', {
    method: 'POST',
    headers: cashfreeHeaders(env),
    body: JSON.stringify({
      order_id: orderId,
      order_amount: amountRupees,
      order_currency: 'INR',
      customer_details: {
        customer_id: tenantId,
        customer_phone: phone,
        customer_name: name || 'Admin',
      },
      order_meta: { payment_methods: 'upi' },
    }),
  });
  const data = await resp.json();
  if (!resp.ok) return json(data, 400);
  return json({ payment_session_id: data.payment_session_id, order_id: data.order_id });
}

// GET /order-status?order_id=... -> proxies Cashfree; settles billing on PAID.
async function handleOrderStatus(req, env, url) {
  const orderId = url.searchParams.get('order_id');
  if (!orderId) return json({ error: 'order_id required' }, 400);

  const resp = await fetch(`https://api.cashfree.com/pg/orders/${orderId}`, { headers: cashfreeHeaders(env) });
  const data = await resp.json();
  if (!resp.ok) return json(data, resp.status);

  if (data.order_status === 'PAID') {
    await settleSubscriptionPayment(env, orderId, data);
  }
  return json(data);
}

async function settleSubscriptionPayment(env, orderId, cfOrder) {
  const pending = await firestoreGet(env, `pendingOrders/${orderId}`);
  if (!pending || !PLANS[pending.plan]) return;
  const { tenantId, plan } = pending;

  const created = await firestoreCreateIfAbsent(env, `tenants/${tenantId}/subscriptionPayments/${orderId}`, {
    plan,
    amountPaise: PLANS[plan].pricePaise,
    cfOrderId: orderId,
    cfPaymentId: (cfOrder.payments && cfOrder.payments[0] && cfOrder.payments[0].cf_payment_id) || '',
    createdAt: new Date(),
  });
  if (!created) return; // a previous poll already settled this order

  const periodEnd = new Date(Date.now() + BILLING_PERIOD_MS);
  await firestorePatch(env, `tenants/${tenantId}`, {
    billingStatus: 'active',
    plan,
    studentCap: PLANS[plan].studentCap,
    waNotifications: PLANS[plan].waNotifications,
    currentPeriodEnd: periodEnd,
  });

  const tenant = await firestoreGet(env, `tenants/${tenantId}`);
  if (tenant && tenant.referredByTenantId && tenant.referralCredited !== true) {
    await firestoreAddDoc(env, `tenants/${tenant.referredByTenantId}/referralPayouts`, {
      amountPaise: REFERRAL_CREDIT_PAISE,
      fromTenantId: tenantId,
      fromSchoolName: tenant.name || tenantId,
      status: 'pending',
      createdAt: new Date(),
    });
    await firestorePatch(env, `tenants/${tenantId}`, { referralCredited: true });
  }
}

// ─── Plumbing ───────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {
      if (url.pathname === '/create-order' && request.method === 'POST') return await handleCreateOrder(request, env);
      if (url.pathname === '/order-status' && request.method === 'GET') return await handleOrderStatus(request, env, url);
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
