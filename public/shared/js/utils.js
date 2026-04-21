// ─── Utilities ────────────────────────────────────────────────────────────────

// ─── Mobile Nav ───────────────────────────────────────────────────────────────

function toggleNav() {
  document.querySelector('.navbar')?.classList.toggle('open');
}
function closeNav() {
  document.querySelector('.navbar')?.classList.remove('open');
}
// Close nav on Escape key
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeNav(); });
// Close nav on resize to desktop
window.addEventListener('resize', () => { if (window.innerWidth > 768) closeNav(); });

// ─── Phone ────────────────────────────────────────────────────────────────────

// Normalise to E.164 (+91XXXXXXXXXX for Indian numbers)
function normalizePhone(raw) {
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;
  return '+' + digits;
}

// Strip +91 for display
function displayPhone(phone) {
  return String(phone || '').replace(/^\+91/, '');
}

// Prevent year > 4 digits in date inputs
function limitDobYear(input) {
  const parts = (input.value || '').split('-');
  if (parts[0] && parts[0].length > 4) {
    parts[0] = parts[0].slice(0, 4);
    input.value = parts.join('-');
  }
}

// ─── Currency ─────────────────────────────────────────────────────────────────

function formatCurrency(paise) {
  const rupees = Math.abs(paise) / 100;
  const formatted = rupees.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  });
  return (paise < 0 ? '−' : '') + '₹' + formatted;
}

function paiseToCurrency(str) {
  const n = parseFloat(String(str).replace(/[₹,]/g, '')) || 0;
  return Math.round(n * 100);
}

// ─── Dates ────────────────────────────────────────────────────────────────────

function formatDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDateTime(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) +
         ', ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function dateRangePreset(preset) {
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (preset) {
    case 'today':
      return { start: today, end: new Date(today.getTime() + 86399999) };
    case 'week': {
      const day = today.getDay();
      const mon = new Date(today); mon.setDate(today.getDate() - day + (day === 0 ? -6 : 1));
      return { start: mon, end: new Date(mon.getTime() + 6 * 86400000 + 86399999) };
    }
    case 'month':
      return {
        start: new Date(now.getFullYear(), now.getMonth(), 1),
        end:   new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
      };
    case 'year':
      return {
        start: new Date(now.getFullYear(), 0, 1),
        end:   new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999)
      };
    case 'prev_month':
      return {
        start: new Date(now.getFullYear(), now.getMonth() - 1, 1),
        end:   new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)
      };
    case 'prev_year':
      return {
        start: new Date(now.getFullYear() - 1, 0, 1),
        end:   new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999)
      };
    default:
      return { start: today, end: new Date(today.getTime() + 86399999) };
  }
}

// ─── Signature Pad ────────────────────────────────────────────────────────────

function initSignaturePad(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#111';
  ctx.lineWidth   = 2;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  let drawing = false, lastX = 0, lastY = 0;

  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    const sx   = canvas.width  / rect.width;
    const sy   = canvas.height / rect.height;
    const cx   = e.touches ? e.touches[0].clientX : e.clientX;
    const cy   = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: (cx - rect.left) * sx, y: (cy - rect.top) * sy };
  }

  function start(e) { e.preventDefault(); drawing = true; const p = pos(e); lastX = p.x; lastY = p.y; }
  function draw(e) {
    e.preventDefault();
    if (!drawing) return;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(p.x, p.y); ctx.stroke();
    lastX = p.x; lastY = p.y;
  }
  function stop() { drawing = false; }

  canvas.addEventListener('mousedown',  start);
  canvas.addEventListener('mousemove',  draw);
  canvas.addEventListener('mouseup',    stop);
  canvas.addEventListener('mouseleave', stop);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove',  draw,  { passive: false });
  canvas.addEventListener('touchend',   stop);

  let _blankData = null;
  function getBlank() {
    if (!_blankData) { ctx.clearRect(0, 0, canvas.width, canvas.height); _blankData = canvas.toDataURL(); }
    return _blankData;
  }

  return {
    clear:      () => { ctx.clearRect(0, 0, canvas.width, canvas.height); _blankData = canvas.toDataURL(); },
    isEmpty:    () => canvas.toDataURL() === getBlank(),
    getDataURL: () => canvas.toDataURL('image/png')
  };
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(message, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3500);
}

// ─── Print ────────────────────────────────────────────────────────────────────

function printElement(elementId, title) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const win = window.open('', '_blank', 'width=800,height=700');
  const css = Array.from(document.styleSheets)
    .map(s => { try { return Array.from(s.cssRules).map(r => r.cssText).join('\n'); } catch { return ''; } })
    .join('\n');
  win.document.write(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8"><title>${title || 'Print'}</title>
    <style>${css}
    body { background: #fff; padding: 20px; font-family: system-ui, sans-serif; }
    .no-print { display: none !important; }
    </style></head><body>${el.outerHTML}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => { win.print(); win.close(); }, 500);
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
