// ─── Tenant resolution ──────────────────────────────────────────────────────
// URL scheme: every page carries ?t={slug} — resolves the slug to a tenant
// before anything else runs (auth, db). Sets db.js's tenant scope via
// setTenantId(). Query-param based (not a /t/{slug}/ path prefix) because
// Firebase Hosting can't dynamically strip a path segment and serve the
// matching static file for a plain multi-page site like this one — that
// trick only works for single-page apps with client-side routing. This also
// matches the app's existing pattern of query-param links (?ref=CODE).

let TENANT = null;

function getTenantSlugFromUrl() {
  return new URLSearchParams(window.location.search).get('t');
}

// Builds a same-tenant URL, e.g. tenantUrl('/admin/dashboard.html').
// extraParams (optional) are merged in alongside ?t=.
function tenantUrl(path, extraParams) {
  const slug = TENANT ? TENANT.slug : getTenantSlugFromUrl();
  const params = new URLSearchParams(extraParams || {});
  params.set('t', slug);
  return `${path}?${params.toString()}`;
}

const TENANT_CACHE_TTL_MS = 5 * 60 * 1000;

function _tenantCacheKey(slug) { return 'sarathi_tenant_' + slug; }

// This is a page-load-speed cache, not a trust boundary: every actual
// Firestore read/write is still gated by real security rules regardless of
// what's cached here, and nothing in the cached tenant doc is sensitive
// (name/address are already public — see the rules comment on tenants/{tid}).
async function resolveTenant() {
  if (TENANT) return TENANT;

  const slug = getTenantSlugFromUrl();
  if (!slug) throw new Error('No school specified in the URL.');

  const cached = sessionStorage.getItem(_tenantCacheKey(slug));
  if (cached) {
    try {
      const { cachedAt, data } = JSON.parse(cached);
      if (Date.now() - cachedAt < TENANT_CACHE_TTL_MS) {
        TENANT = data;
        setTenantId(TENANT.id);
        return TENANT;
      }
    } catch { /* fall through to network */ }
  }

  // Every tenant is created with its ID set equal to its slug (see
  // signup.html) — one direct read, no tenantSlugs indirection needed.
  const tenantSnap = await getDb().collection('tenants').doc(slug).get();
  if (!tenantSnap.exists) throw new Error('School not found.');

  TENANT = { id: slug, slug, ...tenantSnap.data() };
  setTenantId(slug);
  _cacheTenant();
  return TENANT;
}

function _cacheTenant() {
  const { createdAt, ...cacheable } = TENANT; // Timestamp doesn't survive JSON round-trips
  sessionStorage.setItem(_tenantCacheKey(TENANT.slug), JSON.stringify({ cachedAt: Date.now(), data: cacheable }));
}

// Call after writing tenant settings so the current tab reflects the change
// immediately instead of waiting out the cache TTL (see masters.html).
function updateTenantCache(fields) {
  TENANT = { ...TENANT, ...fields };
  _cacheTenant();
}

function getTenant() {
  if (!TENANT) throw new Error('Tenant not resolved yet — call resolveTenant() first.');
  return TENANT;
}
