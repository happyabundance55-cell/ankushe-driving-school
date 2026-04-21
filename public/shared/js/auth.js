// Session-based auth — no Firebase Auth SDK required.
// Session stored in localStorage (persists across tabs and browser restarts).

function initFirebase() {
  if (!firebase.apps.length) {
    firebase.initializeApp(FIREBASE_CONFIG);
  }
  return { db: firebase.firestore() };
}

function _getSession() {
  try { return JSON.parse(localStorage.getItem('_session') || 'null'); } catch { return null; }
}

function _setSession(s) {
  localStorage.setItem('_session', JSON.stringify(s));
}

function requireAuth(allowedRoles) {
  initFirebase();
  const session = _getSession();
  if (!session) {
    window.location.href = '/login.html';
    return new Promise(() => {});
  }
  if (allowedRoles && !allowedRoles.includes(session.role)) {
    window.location.href = '/login.html';
    return new Promise(() => {});
  }
  return Promise.resolve({ user: session, profile: session });
}

function getCurrentUser() { return _getSession(); }

function logout() {
  localStorage.removeItem('_session');
  window.location.href = '/login.html';
}

// Google Drive OAuth token helpers
function setDriveToken(t)  { localStorage.setItem('driveToken', t); }
function getDriveToken()   { return localStorage.getItem('driveToken'); }
function clearDriveToken() { localStorage.removeItem('driveToken'); }
