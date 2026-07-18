// ─── Firestore helpers ────────────────────────────────────────────────────────
// All Firestore writes go through functions here.
// Money: always stored and returned in PAISE (integer).
// Tenant-scoped collections live under tenants/{tenantId}/... — call
// setTenantId() (done automatically by tenant.js's resolveTenant()) before
// using any of the tenant-scoped functions below.
// `users/{uid}` (identity/role) and `pendingInvites/{phone}` (mentor invites)
// are top-level, keyed by Firebase Auth UID / phone respectively.

let _tenantId = null;

function setTenantId(id) { _tenantId = id; }

function getDb() {
  if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
  return firebase.firestore();
}

function tenantRef() {
  if (!_tenantId) throw new Error('Tenant not resolved yet.');
  return getDb().collection('tenants').doc(_tenantId);
}

function tenantCol(name) {
  return tenantRef().collection(name);
}

// ─── Tenant settings ────────────────────────────────────────────────────────

async function getTenantSettings() {
  const snap = await tenantRef().get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function updateTenantSettings(fields) {
  await tenantRef().update(fields);
}

// ─── Enrollment Number ────────────────────────────────────────────────────────

async function getNextEnrollmentNumber() {
  const db  = getDb();
  const ref = tenantCol('counters').doc('enrollmentNumber');
  const year = new Date().getFullYear();
  let enroll = '';
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    let seq = 1;
    if (snap.exists && snap.data().year === year) {
      seq = snap.data().seq + 1;
    }
    tx.set(ref, { year, seq });
    enroll = `${getTenant().enrollmentPrefix || 'DS'}-${year}-${String(seq).padStart(3, '0')}`;
  });
  return enroll;
}

// ─── Students ─────────────────────────────────────────────────────────────────

async function createStudent(data) {
  const db = getDb();
  const enrollmentNumber = await getNextEnrollmentNumber();
  const phone = normalizePhone(data.phone);
  const student = {
    name:             data.name,
    phone,
    guardianPhone:    data.guardianPhone   || '',
    guardianName:     data.guardianName    || '',
    relation:         data.relation        || '',
    dob:              data.dob             || '',
    address:          data.address         || '',
    addressFlat:      data.addressFlat     || '',
    addressLine2:     data.addressLine2    || '',
    addressArea:      data.addressArea     || '',
    addressDistrictState: data.addressDistrictState || '',
    pincode:          data.pincode         || '',
    tempAddressSame:  data.tempAddressSame !== false,
    tempAddressFlat:  data.tempAddressFlat  || '',
    tempAddressLine2: data.tempAddressLine2 || '',
    tempAddressPincode: data.tempAddressPincode || '',
    tempAddressArea:  data.tempAddressArea  || '',
    tempAddressDistrictState: data.tempAddressDistrictState || '',
    vehicleClass:     data.vehicleClass    || '',
    vehicleRegNo:     data.vehicleRegNo    || '',
    learnerLicenceNo: data.learnerLicenceNo || '',
    learnerLicenceExpiry: data.learnerLicenceExpiry || '',
    testPassDate:     data.testPassDate    || '',
    dlNumber:         data.dlNumber        || '',
    dlIssueDate:      data.dlIssueDate     || '',
    dlAuthority:      data.dlAuthority     || '',
    enrollmentNumber,
    enrollmentDate:   firebase.firestore.Timestamp.fromDate(new Date(data.enrollmentDate)),
    photoURL:         data.photoURL        || '',
    photoPublicId:    data.photoPublicId   || '',
    totalFee:         Number(data.totalFee),
    paidFee:          Number(data.paidFee) || 0,
    balance:          Number(data.totalFee) - (Number(data.paidFee) || 0),
    referredBy:       data.referredBy      || null,
    referralApplied:  false,
    status:           'active',
    createdAt:        firebase.firestore.FieldValue.serverTimestamp()
  };

  const ref = tenantCol('students').doc();
  const batch = db.batch();
  batch.set(ref, student);
  // Lets this phone number link to this record on its first OTP sign-in.
  batch.set(tenantCol('studentsByPhone').doc(phone), { studentId: ref.id });
  // Public-safe projection so this student can be looked up as a referrer
  // from the (unauthenticated) referral-link banner.
  batch.set(tenantCol('referralCodes').doc(enrollmentNumber), { referrerId: ref.id, referrerName: student.name });
  await batch.commit();

  return { id: ref.id, ...student, enrollmentNumber };
}

async function getStudent(id) {
  const snap = await tenantCol('students').doc(id).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function getStudentByEnrollment(enrollmentNo) {
  const snap = await tenantCol('students')
    .where('enrollmentNumber', '==', enrollmentNo).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function updateStudent(id, data) {
  const db = getDb();
  const existing = await getStudent(id);
  if (!existing) throw new Error('Student not found');

  const updates = { ...data };
  const batch = db.batch();

  if (data.phone) {
    updates.phone = normalizePhone(data.phone);
    if (updates.phone !== existing.phone) {
      batch.delete(tenantCol('studentsByPhone').doc(existing.phone));
      batch.set(tenantCol('studentsByPhone').doc(updates.phone), { studentId: id });
    }
  }
  if (data.name && data.name !== existing.name && existing.enrollmentNumber) {
    batch.set(tenantCol('referralCodes').doc(existing.enrollmentNumber), { referrerId: id, referrerName: data.name });
  }

  batch.update(tenantCol('students').doc(id), updates);
  await batch.commit();
}

async function getStudents({ status, search } = {}) {
  let q = tenantCol('students').orderBy('enrollmentNumber', 'asc');
  if (status && status !== 'all') q = q.where('status', '==', status);
  const snap = await q.get();
  let students = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (search) {
    const s = search.toLowerCase();
    students = students.filter(st =>
      st.name.toLowerCase().includes(s) ||
      st.phone.includes(s) ||
      st.enrollmentNumber.toLowerCase().includes(s)
    );
  }
  return students;
}

async function updateStudentPhoto(studentId, { url, publicId }) {
  await tenantCol('students').doc(studentId).update({ photoURL: url, photoPublicId: publicId || '' });
}

// ─── Payments ─────────────────────────────────────────────────────────────────

async function recordPayment(studentId, amountPaise, method, note) {
  const db = getDb();
  const student = await getStudent(studentId);
  if (!student) throw new Error('Student not found');

  const newPaid    = student.paidFee + amountPaise;
  const newBalance = student.totalFee - newPaid;

  const batch = db.batch();

  const payRef = tenantCol('payments').doc();
  batch.set(payRef, {
    studentId,
    studentName:      student.name,
    enrollmentNumber: student.enrollmentNumber,
    amount:           amountPaise,
    method:           method || 'cash',
    note:             note   || '',
    date:             firebase.firestore.Timestamp.now(),
    createdAt:        firebase.firestore.FieldValue.serverTimestamp()
  });

  batch.update(tenantCol('students').doc(studentId), {
    paidFee: newPaid,
    balance: newBalance
  });

  await batch.commit();
  await _checkReferralTrigger(studentId);

  return { paymentId: payRef.id, newPaid, newBalance };
}

async function _checkReferralTrigger(referredStudentId) {
  const refSnap = await tenantCol('referrals')
    .where('referredId', '==', referredStudentId)
    .where('status', '==', 'pending')
    .limit(1).get();
  if (refSnap.empty) return;
  await refSnap.docs[0].ref.update({
    status:      'triggered',
    triggeredAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

async function getStudentPayments(studentId) {
  const snap = await tenantCol('payments')
    .where('studentId', '==', studentId)
    .orderBy('date', 'desc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getPaymentsByDateRange(startDate, endDate) {
  const start = firebase.firestore.Timestamp.fromDate(startDate);
  const end   = firebase.firestore.Timestamp.fromDate(endDate);
  const snap = await tenantCol('payments')
    .where('date', '>=', start)
    .where('date', '<=', end)
    .orderBy('date', 'asc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ─── Attendance ───────────────────────────────────────────────────────────────
// markedBy is the marking staff member's Firebase Auth UID (not phone).

async function markAttendance({ studentId, date, markedBy, markedByRole, mentorName, signatureDataURL }) {
  const db = getDb();
  const student = await getStudent(studentId);
  if (!student) throw new Error('Student not found');

  // 40-minute duplicate guard
  const recentSnap = await tenantCol('attendance')
    .where('studentId', '==', studentId)
    .orderBy('date', 'desc').limit(1).get();
  if (!recentSnap.empty) {
    const lastMs = (() => { const d = recentSnap.docs[0].data().date; return d?.toMillis ? d.toMillis() : new Date(d).getTime(); })();
    const elapsedMin = (Date.now() - lastMs) / 60000;
    if (elapsedMin < 40) {
      const waitMin = Math.ceil(40 - elapsedMin);
      throw new Error(`Attendance already marked ${Math.floor(elapsedMin)} min ago. Try again in ${waitMin} minute${waitMin !== 1 ? 's' : ''}.`);
    }
  }

  const ts = date
    ? firebase.firestore.Timestamp.fromDate(new Date(date))
    : firebase.firestore.Timestamp.now();
  const rec = {
    studentId,
    studentName:      student.name,
    enrollmentNumber: student.enrollmentNumber,
    date:             ts,
    markedBy,
    markedByRole,
    mentorName:       mentorName      || '',
    signatureDataURL: signatureDataURL || '',
    createdAt:        firebase.firestore.FieldValue.serverTimestamp()
  };
  const ref = await tenantCol('attendance').add(rec);
  return { id: ref.id, ...rec };
}

async function getMentorAttendance(mentorUid) {
  const snap = await tenantCol('attendance')
    .where('markedBy', '==', mentorUid).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getStudentAttendance(studentId) {
  const snap = await tenantCol('attendance')
    .where('studentId', '==', studentId)
    .orderBy('date', 'desc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getAllAttendance({ startDate, endDate, studentId } = {}) {
  let q = tenantCol('attendance').orderBy('date', 'desc');
  if (startDate) q = q.where('date', '>=', firebase.firestore.Timestamp.fromDate(startDate));
  if (endDate)   q = q.where('date', '<=', firebase.firestore.Timestamp.fromDate(endDate));
  if (studentId) q = q.where('studentId', '==', studentId);
  const snap = await q.get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function deleteAttendance(id) {
  await tenantCol('attendance').doc(id).delete();
}

// ─── Mentors ──────────────────────────────────────────────────────────────────
// Mentors don't get created directly (no self-registration hole). Admin
// creates a pendingInvites entry; the mentor's real users/{uid} doc is
// created by them, client-side, on their first phone-OTP sign-in — see
// shared/js/auth.js's completeMentorLink().

async function createMentorInvite(name, phone, joiningDate) {
  const normalised = normalizePhone(phone);
  const db = getDb();
  const existingInvite = await db.collection('pendingInvites').doc(normalised).get();
  if (existingInvite.exists) throw new Error('This phone number already has a pending invite.');
  const existingUser = await db.collection('users')
    .where('tenantId', '==', _tenantId).where('phone', '==', normalised).limit(1).get();
  if (!existingUser.empty) throw new Error('This phone number is already registered.');
  await db.collection('pendingInvites').doc(normalised).set({
    tenantId: _tenantId,
    role: 'mentor',
    name,
    phone: normalised,
    joiningDate: joiningDate
      ? firebase.firestore.Timestamp.fromDate(new Date(joiningDate))
      : firebase.firestore.Timestamp.now(),
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

async function getPendingMentorInvites() {
  const snap = await getDb().collection('pendingInvites')
    .where('tenantId', '==', _tenantId).where('role', '==', 'mentor').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function revokeMentorInvite(phone) {
  await getDb().collection('pendingInvites').doc(normalizePhone(phone)).delete();
}

async function getMentors() {
  const snap = await getDb().collection('users')
    .where('tenantId', '==', _tenantId).where('role', '==', 'mentor').orderBy('name').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getActiveInstructors() {
  const all = await getMentors();
  return all.filter(m => (m.status || 'active') === 'active');
}

async function setMentorStatus(uid, status) {
  await getDb().collection('users').doc(uid).update({ status });
}

async function deleteMentor(uid) {
  await getDb().collection('users').doc(uid).delete();
}

// ─── Referrals ────────────────────────────────────────────────────────────────

async function createReferral({ referrerId, referrerId_enrollmentNo, referrerName, referredId, referredName }) {
  const db = getDb();
  const referred = await getStudent(referredId);
  if (!referred) throw new Error('Referred student not found');

  const discountPaise   = getTenant().referralDiscountPaise ?? 20000;
  const rewardPaise     = getTenant().referralRewardPaise ?? 20000;
  const discountedTotal = referred.totalFee - discountPaise;
  const newBalance      = discountedTotal   - referred.paidFee;

  const batch = db.batch();

  const refRef = tenantCol('referrals').doc();
  batch.set(refRef, {
    referrerId,
    referrerId_enrollmentNo,
    referrerName,
    referredId,
    referredName,
    rewardAmount:   rewardPaise,
    discountAmount: discountPaise,
    status:         'pending',
    createdAt:      firebase.firestore.FieldValue.serverTimestamp(),
    triggeredAt:    null,
    paidAt:         null
  });

  batch.update(tenantCol('students').doc(referredId), {
    totalFee:        discountedTotal,
    balance:         newBalance,
    referralApplied: true,
    referredBy:      referrerId
  });

  await batch.commit();
  return refRef.id;
}

async function getReferrals() {
  const snap = await tenantCol('referrals')
    .orderBy('createdAt', 'desc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Public-safe lookup for the pre-login referral banner — reads only the
// referralCodes projection (name only), never the full students collection.
async function getReferralCode(refCode) {
  const snap = await tenantCol('referralCodes').doc(refCode).get();
  return snap.exists ? snap.data() : null;
}

async function logReferralVisit(refCode) {
  const referrer = await getReferralCode(refCode);
  if (!referrer) return null;
  await tenantCol('referralVisits').add({
    refCode,
    referrerId:   referrer.referrerId,
    referrerName: referrer.referrerName,
    enrollmentNo: refCode,
    clickedAt:    firebase.firestore.FieldValue.serverTimestamp()
  });
  return referrer;
}

async function getReferralVisits() {
  const snap = await tenantCol('referralVisits')
    .orderBy('clickedAt', 'desc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function markReferralPaid(referralId) {
  await tenantCol('referrals').doc(referralId).update({
    status: 'paid',
    paidAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

// ─── Fee Adjustments ──────────────────────────────────────────────────────────

async function recordFeeAdjustment(studentId, oldTotal, newTotal, note) {
  const db      = getDb();
  const student = await getStudent(studentId);
  if (!student) throw new Error('Student not found');

  const batch = db.batch();

  batch.set(tenantCol('feeAdjustments').doc(), {
    studentId,
    studentName:      student.name,
    enrollmentNumber: student.enrollmentNumber,
    oldTotal,
    newTotal,
    note:        note || '',
    adjustedAt:  firebase.firestore.FieldValue.serverTimestamp()
  });

  batch.update(tenantCol('students').doc(studentId), {
    totalFee: newTotal,
    balance:  newTotal - student.paidFee
  });

  await batch.commit();
}

async function getFeeAdjustments(studentId) {
  const snap = await tenantCol('feeAdjustments')
    .where('studentId', '==', studentId)
    .orderBy('adjustedAt', 'desc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ─── Driving Tests ───────────────────────────────────────────────────────────

async function scheduleDrivingTest(studentId, { scheduledAt, venue, notes }) {
  const student = await getStudent(studentId);
  if (!student) throw new Error('Student not found');
  const ref = await tenantCol('drivingTests').add({
    studentId,
    studentName:      student.name,
    enrollmentNumber: student.enrollmentNumber,
    scheduledAt:      firebase.firestore.Timestamp.fromDate(new Date(scheduledAt)),
    venue:            venue || '',
    notes:            notes || '',
    status:           'scheduled',
    createdAt:        firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt:        firebase.firestore.FieldValue.serverTimestamp()
  });
  return ref.id;
}

async function updateDrivingTest(testId, updates) {
  const data = { ...updates, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
  if (updates.scheduledAt) data.scheduledAt = firebase.firestore.Timestamp.fromDate(new Date(updates.scheduledAt));
  await tenantCol('drivingTests').doc(testId).update(data);
}

async function deleteDrivingTest(testId) {
  await tenantCol('drivingTests').doc(testId).delete();
}

async function getAllDrivingTests() {
  const snap = await tenantCol('drivingTests').orderBy('scheduledAt', 'asc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getStudentDrivingTests(studentId) {
  const snap = await tenantCol('drivingTests')
    .where('studentId', '==', studentId)
    .orderBy('scheduledAt', 'desc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getUpcomingDrivingTest(studentId) {
  const all = await getStudentDrivingTests(studentId);
  const now = Date.now();
  return all
    .filter(t => t.status === 'scheduled' && t.scheduledAt?.toMillis?.() >= now)
    .sort((a, b) => (a.scheduledAt?.toMillis?.() || 0) - (b.scheduledAt?.toMillis?.() || 0))[0] || null;
}

async function getTodaysDrivingTests() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end   = new Date(); end.setHours(23, 59, 59, 999);
  const snap  = await tenantCol('drivingTests')
    .where('scheduledAt', '>=', firebase.firestore.Timestamp.fromDate(start))
    .where('scheduledAt', '<=', firebase.firestore.Timestamp.fromDate(end))
    .orderBy('scheduledAt', 'asc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ─── Revenue ──────────────────────────────────────────────────────────────────

async function getRevenueSummary(startDate, endDate) {
  const payments = await getPaymentsByDateRange(startDate, endDate);
  const total    = payments.reduce((s, p) => s + p.amount, 0);
  return { total, count: payments.length, payments };
}

async function getOutstandingBalances() {
  const snap = await tenantCol('students')
    .where('balance', '>', 0)
    .where('status', '==', 'active')
    .orderBy('balance', 'desc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ─── Vehicle Classes ──────────────────────────────────────────────────────────

async function getVehicleClasses() {
  const snap = await tenantCol('vehicleClasses').orderBy('name').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function addVehicleClass(name) {
  const n = name.trim().toUpperCase();
  if (!n) throw new Error('Vehicle class name cannot be empty.');
  const snap = await tenantCol('vehicleClasses').where('name', '==', n).limit(1).get();
  if (!snap.empty) throw new Error('Vehicle class already exists.');
  await tenantCol('vehicleClasses').add({ name: n, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
}

async function deleteVehicleClass(id) {
  await tenantCol('vehicleClasses').doc(id).delete();
}

// ─── DL Issuing Authorities ───────────────────────────────────────────────────

async function getDLAuthorities() {
  const snap = await tenantCol('dlAuthorities').orderBy('name').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function addDLAuthority(name) {
  const n = name.trim().toUpperCase();
  if (!n) throw new Error('Authority name cannot be empty.');
  const snap = await tenantCol('dlAuthorities').where('name', '==', n).limit(1).get();
  if (!snap.empty) throw new Error('Authority already exists.');
  await tenantCol('dlAuthorities').add({ name: n, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
}

async function deleteDLAuthority(id) {
  await tenantCol('dlAuthorities').doc(id).delete();
}

// ─── Training Vehicles ────────────────────────────────────────────────────────

async function getTrainingVehicles() {
  const snap = await tenantCol('trainingVehicles').orderBy('regNo').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function addTrainingVehicle(regNo, description) {
  const n = regNo.trim().toUpperCase();
  if (!n) throw new Error('Registration number cannot be empty.');
  const snap = await tenantCol('trainingVehicles').where('regNo', '==', n).limit(1).get();
  if (!snap.empty) throw new Error('This vehicle is already in the list.');
  await tenantCol('trainingVehicles').add({
    regNo: n,
    description: (description || '').trim(),
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

async function deleteTrainingVehicle(id) {
  await tenantCol('trainingVehicles').doc(id).delete();
}

// ─── Roster ───────────────────────────────────────────────────────────────────

async function getRosterSlots(weekStart) {
  const snap = await tenantCol('rosterSlots')
    .where('weekStart', '==', weekStart)
    .orderBy('date').orderBy('instructorName').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function addRosterSlot({ weekStart, date, instructorPhone, instructorName, studentId, studentName, enrollmentNumber }) {
  const existing = await tenantCol('rosterSlots')
    .where('weekStart', '==', weekStart)
    .where('date', '==', date)
    .where('studentId', '==', studentId).limit(1).get();
  if (!existing.empty) throw new Error(`${studentName} is already on the roster for this day.`);
  await tenantCol('rosterSlots').add({
    weekStart, date, instructorPhone, instructorName,
    studentId, studentName, enrollmentNumber,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

async function deleteRosterSlot(id) {
  await tenantCol('rosterSlots').doc(id).delete();
}

async function clearRosterWeek(weekStart) {
  const snap = await tenantCol('rosterSlots').where('weekStart', '==', weekStart).get();
  const batch = getDb().batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

async function autoGenerateRoster(weekStart, students, instructors) {
  if (!instructors.length) throw new Error('No active instructors found.');
  if (!students.length)    throw new Error('No active students found.');

  await clearRosterWeek(weekStart);

  const monday = new Date(weekStart + 'T00:00:00');
  const batch  = getDb().batch();
  let slotCount = 0;

  for (let dayOffset = 0; dayOffset < 6; dayOffset++) {  // Mon–Sat
    const d = new Date(monday);
    d.setDate(monday.getDate() + dayOffset);
    const dateStr = d.toISOString().slice(0, 10);
    students.forEach((s, i) => {
      const instr = instructors[i % instructors.length];
      const ref = tenantCol('rosterSlots').doc();
      batch.set(ref, {
        weekStart,
        date:            dateStr,
        instructorPhone: instr.phone,
        instructorName:  instr.name,
        studentId:       s.id,
        studentName:     s.name,
        enrollmentNumber: s.enrollmentNumber,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      slotCount++;
    });
  }
  await batch.commit();
  return slotCount;
}
