// Seed script — uses Firestore REST API (rules: allow read,write: if true)
const https = require('https');

const PROJECT = 'ankushedrivingschool';
const BASE    = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const url  = new URL(BASE + path);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const r = https.request(opts, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`${res.statusCode} ${buf.slice(0,200)}`));
        else resolve(JSON.parse(buf));
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// Firestore field value helpers
const S  = v => ({ stringValue:  String(v) });
const N  = v => ({ integerValue: String(Math.round(v)) });
const B  = v => ({ booleanValue: v });
const TS = d => ({ timestampValue: d.toISOString() });
const NL =  () => ({ nullValue: 'NULL_VALUE' });

function doc(fields) { return { fields }; }

// ── dates ──────────────────────────────────────────────────────────────────
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
function daysAgoAt(n, h, m) { const d = daysAgo(n); d.setHours(h, m, 0, 0); return d; }

async function patch(collection, id, fields) {
  const mask = Object.keys(fields).map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
  return req('PATCH', `/${collection}/${encodeURIComponent(id)}?${mask}`, doc(fields));
}
async function post(collection, fields) {
  return req('POST', `/${collection}`, doc(fields));
}

// ── counters/setup (mark setup done) ──────────────────────────────────────
async function seedSetup() {
  await patch('counters', 'setup', { completedAt: TS(new Date()) });
  console.log('✓ counters/setup');
}

// ── enrollment counter ─────────────────────────────────────────────────────
async function seedCounter() {
  await patch('counters', 'enrollmentNumber', { year: N(2026), seq: N(6) });
  console.log('✓ counters/enrollmentNumber (seq=6)');
}

// ── mentors ────────────────────────────────────────────────────────────────
const MENTORS = [
  { phone: '+919876500001', name: 'Rajan Patil',  email: 'rajan@ankushe.in'  },
  { phone: '+919876500002', name: 'Sneha Kulkarni', email: 'sneha@ankushe.in' },
];

async function seedMentors() {
  for (const m of MENTORS) {
    await patch('users', m.phone, {
      name: S(m.name), phone: S(m.phone), email: S(m.email),
      role: S('mentor'), studentId: NL(),
      createdAt: TS(daysAgo(30))
    });
    console.log(`✓ mentor ${m.name}`);
  }
}

// ── admin ──────────────────────────────────────────────────────────────────
async function seedAdmin() {
  await patch('users', '+918451046072', {
    name: S('Admin'), phone: S('+918451046072'),
    role: S('admin'), studentId: NL(),
    createdAt: TS(daysAgo(60))
  });
  console.log('✓ admin +918451046072');
}

// ── students ───────────────────────────────────────────────────────────────
const STUDENTS = [
  { id: 'STU001', enrollNo: 'DS-2026-001', name: 'Amit Sharma',    phone: '+919000000001', addr: 'Flat 3, Shivaji Nagar, Pune', totalFee: 700000, paidFee: 700000, enrollDay: 90 },
  { id: 'STU002', enrollNo: 'DS-2026-002', name: 'Priya Desai',    phone: '+919000000002', addr: '12 MG Road, Pune',            totalFee: 800000, paidFee: 500000, enrollDay: 75 },
  { id: 'STU003', enrollNo: 'DS-2026-003', name: 'Rahul Joshi',    phone: '+919000000003', addr: '7 Laxmi Colony, Kothrud',    totalFee: 750000, paidFee: 250000, enrollDay: 60 },
  { id: 'STU004', enrollNo: 'DS-2026-004', name: 'Kavita Nair',    phone: '+919000000004', addr: '45 FC Road, Shivajinagar',   totalFee: 700000, paidFee: 700000, enrollDay: 55 },
  { id: 'STU005', enrollNo: 'DS-2026-005', name: 'Suresh Pawar',   phone: '+919000000005', addr: 'Plot 9, Hadapsar',           totalFee: 800000, paidFee: 800000, enrollDay: 40 },
  { id: 'STU006', enrollNo: 'DS-2026-006', name: 'Meena Kulkarni', phone: '+919000000006', addr: '23 Baner Road',              totalFee: 750000, paidFee: 0,      enrollDay: 20 },
];

async function seedStudents() {
  for (const s of STUDENTS) {
    const balance = s.totalFee - s.paidFee;
    const enrollDate = daysAgo(s.enrollDay);

    // users record
    await patch('users', s.phone, {
      name: S(s.name), phone: S(s.phone),
      role: S('student'), studentId: S(s.id),
      createdAt: TS(enrollDate)
    });

    // students record
    await patch('students', s.id, {
      name: S(s.name), phone: S(s.phone),
      address: S(s.addr),
      enrollmentNumber: S(s.enrollNo),
      enrollmentDate: TS(enrollDate),
      photoFileId: NL(), photoURL: NL(),
      totalFee: N(s.totalFee),
      paidFee:  N(s.paidFee),
      balance:  N(balance),
      referredBy: NL(), referralApplied: B(false),
      status: S(balance === 0 ? 'active' : 'active'),
      createdAt: TS(enrollDate)
    });

    console.log(`✓ student ${s.name} (${s.enrollNo}) balance ₹${balance/100}`);
  }
}

// ── payments ───────────────────────────────────────────────────────────────
const PAYMENTS = [
  { studentId: 'STU001', amount: 350000, method: 'cash',   note: 'First instalment',  daysAgoN: 89 },
  { studentId: 'STU001', amount: 350000, method: 'upi',    note: 'Final payment',      daysAgoN: 60 },
  { studentId: 'STU002', amount: 300000, method: 'cash',   note: 'Advance',            daysAgoN: 74 },
  { studentId: 'STU002', amount: 200000, method: 'upi',    note: 'Instalment 2',       daysAgoN: 40 },
  { studentId: 'STU003', amount: 250000, method: 'cash',   note: 'First instalment',  daysAgoN: 59 },
  { studentId: 'STU004', amount: 400000, method: 'upi',    note: 'Advance',            daysAgoN: 54 },
  { studentId: 'STU004', amount: 300000, method: 'cash',   note: 'Balance cleared',    daysAgoN: 30 },
  { studentId: 'STU005', amount: 500000, method: 'upi',    note: 'First instalment',  daysAgoN: 39 },
  { studentId: 'STU005', amount: 300000, method: 'online', note: 'Final payment',      daysAgoN: 15 },
];

async function seedPayments() {
  for (const p of PAYMENTS) {
    await post('payments', {
      studentId: S(p.studentId),
      amount:    N(p.amount),
      method:    S(p.method),
      note:      S(p.note),
      date:      TS(daysAgo(p.daysAgoN)),
      createdAt: TS(daysAgo(p.daysAgoN))
    });
    console.log(`✓ payment ${p.studentId} ₹${p.amount/100}`);
  }
}

// ── attendance ─────────────────────────────────────────────────────────────
// Each student gets ~8 attendance records spread over past weeks
const ATT_TEMPLATE = [
  // [studentId, daysAgo, hour, mentorIdx]
  ['STU001', 85, 9,  0], ['STU001', 80, 10, 1], ['STU001', 75, 9,  0],
  ['STU001', 70, 11, 1], ['STU001', 65, 9,  0], ['STU001', 60, 10, 0],
  ['STU002', 72, 9,  0], ['STU002', 67, 10, 1], ['STU002', 62, 9,  1],
  ['STU002', 57, 11, 0], ['STU002', 52, 9,  0], ['STU002', 47, 10, 1],
  ['STU003', 58, 9,  1], ['STU003', 53, 10, 0], ['STU003', 48, 9,  1],
  ['STU003', 43, 11, 0], ['STU003', 38, 9,  1],
  ['STU004', 50, 9,  0], ['STU004', 45, 10, 1], ['STU004', 40, 9,  0],
  ['STU004', 35, 11, 1], ['STU004', 30, 9,  0], ['STU004', 25, 10, 0],
  ['STU004', 20, 9,  1],
  ['STU005', 38, 9,  1], ['STU005', 33, 10, 0], ['STU005', 28, 9,  1],
  ['STU005', 23, 11, 0], ['STU005', 18, 9,  1], ['STU005', 13, 10, 0],
  ['STU005', 8,  9,  1], ['STU005', 3,  10, 0],
  ['STU006', 18, 9,  0], ['STU006', 13, 10, 1], ['STU006', 8,  9,  0],
  ['STU006', 3,  11, 1],
];

async function seedAttendance() {
  for (const [sid, day, hr, mi] of ATT_TEMPLATE) {
    const mentor = MENTORS[mi];
    const d = daysAgoAt(day, hr, 0);
    const dateStr = d.toISOString().slice(0, 10);
    await post('attendance', {
      studentId:      S(sid),
      date:           S(dateStr),
      markedBy:       S(mentor.phone),
      markedByRole:   S('mentor'),
      mentorName:     S(mentor.name),
      signatureDataURL: S(''),
      createdAt:      TS(d)
    });
  }
  console.log(`✓ attendance (${ATT_TEMPLATE.length} records)`);
}

// ── referral example ───────────────────────────────────────────────────────
async function seedReferrals() {
  await post('referrals', {
    referrerId:           S('STU001'),
    referrerId_enrollmentNo: S('DS-2026-001'),
    referrerName:         S('Amit Sharma'),
    referredId:           S('STU003'),
    referredName:         S('Rahul Joshi'),
    rewardAmount:         N(20000),
    discountAmount:       N(20000),
    status:               S('triggered'),
    createdAt:            TS(daysAgo(60))
  });
  console.log('✓ referral STU001 → STU003');
}

// ── main ───────────────────────────────────────────────────────────────────
(async () => {
  try {
    await seedSetup();
    await seedCounter();
    await seedAdmin();
    await seedMentors();
    await seedStudents();
    await seedPayments();
    await seedAttendance();
    await seedReferrals();
    console.log('\n✅ Seed complete!');
  } catch (e) {
    console.error('❌', e.message);
    process.exit(1);
  }
})();
