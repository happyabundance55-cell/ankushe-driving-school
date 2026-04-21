// ─── Firestore helpers ────────────────────────────────────────────────────────
// All Firestore writes go through functions here.
// Money: always stored and returned in PAISE (integer).
// Users: doc ID is the normalised phone number (+91XXXXXXXXXX).

function getDb() {
  if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
  return firebase.firestore();
}

// ─── Enrollment Number ────────────────────────────────────────────────────────

async function getNextEnrollmentNumber() {
  const db  = getDb();
  const ref = db.collection('counters').doc('enrollmentNumber');
  const year = new Date().getFullYear();
  let enroll = '';
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    let seq = 1;
    if (snap.exists && snap.data().year === year) {
      seq = snap.data().seq + 1;
    }
    tx.set(ref, { year, seq });
    enroll = `${ENROLLMENT_PREFIX}-${year}-${String(seq).padStart(3, '0')}`;
  });
  return enroll;
}

// ─── Students ─────────────────────────────────────────────────────────────────

async function createStudent(data) {
  const db = getDb();
  const enrollmentNumber = await getNextEnrollmentNumber();
  const student = {
    name:             data.name,
    phone:            normalizePhone(data.phone),
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
    photoStoragePath: data.photoStoragePath || '',
    photoArchived:    false,
    totalFee:         Number(data.totalFee),
    paidFee:          Number(data.paidFee) || 0,
    balance:          Number(data.totalFee) - (Number(data.paidFee) || 0),
    referredBy:       data.referredBy      || null,
    referralApplied:  false,
    status:           'active',
    createdAt:        firebase.firestore.FieldValue.serverTimestamp()
  };

  const ref = await db.collection('students').add(student);

  // Create login entry for student
  await db.collection('users').doc(student.phone).set({
    name:      student.name,
    phone:     student.phone,
    role:      'student',
    studentId: ref.id,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });

  return { id: ref.id, ...student, enrollmentNumber };
}

async function getStudent(id) {
  const snap = await getDb().collection('students').doc(id).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function getStudentByEnrollment(enrollmentNo) {
  const snap = await getDb().collection('students')
    .where('enrollmentNumber', '==', enrollmentNo).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function updateStudent(id, data) {
  const updates = { ...data };
  if (data.phone) updates.phone = normalizePhone(data.phone);
  await getDb().collection('students').doc(id).update(updates);

  // Keep users doc in sync when name or phone changes
  if (data.name || data.phone) {
    const student = await getStudent(id);
    if (student) {
      const phone = student.phone;
      await getDb().collection('users').doc(phone).set({
        name:      student.name,
        phone,
        role:      'student',
        studentId: id
      }, { merge: true });
    }
  }
}

async function getStudents({ status, search } = {}) {
  let q = getDb().collection('students').orderBy('enrollmentNumber', 'asc');
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

// ─── Payments ─────────────────────────────────────────────────────────────────

async function recordPayment(studentId, amountPaise, method, note) {
  const db = getDb();
  const student = await getStudent(studentId);
  if (!student) throw new Error('Student not found');

  const newPaid    = student.paidFee + amountPaise;
  const newBalance = student.totalFee - newPaid;

  const batch = db.batch();

  const payRef = db.collection('payments').doc();
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

  batch.update(db.collection('students').doc(studentId), {
    paidFee: newPaid,
    balance: newBalance
  });

  await batch.commit();
  await _checkReferralTrigger(studentId, db);

  return { paymentId: payRef.id, newPaid, newBalance };
}

async function _checkReferralTrigger(referredStudentId, db) {
  const refSnap = await db.collection('referrals')
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
  const snap = await getDb().collection('payments')
    .where('studentId', '==', studentId)
    .orderBy('date', 'desc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getPaymentsByDateRange(startDate, endDate) {
  const start = firebase.firestore.Timestamp.fromDate(startDate);
  const end   = firebase.firestore.Timestamp.fromDate(endDate);
  const snap = await getDb().collection('payments')
    .where('date', '>=', start)
    .where('date', '<=', end)
    .orderBy('date', 'asc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ─── Attendance ───────────────────────────────────────────────────────────────

async function markAttendance({ studentId, date, markedBy, markedByRole, mentorName, signatureDataURL }) {
  const db = getDb();
  const student = await getStudent(studentId);
  if (!student) throw new Error('Student not found');

  // 40-minute duplicate guard
  const recentSnap = await db.collection('attendance')
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
  const ref = await db.collection('attendance').add(rec);
  return { id: ref.id, ...rec };
}

async function getMentorAttendance(mentorPhone) {
  const snap = await getDb().collection('attendance')
    .where('markedBy', '==', mentorPhone).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getStudentAttendance(studentId) {
  const snap = await getDb().collection('attendance')
    .where('studentId', '==', studentId)
    .orderBy('date', 'desc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getAllAttendance({ startDate, endDate, studentId } = {}) {
  let q = getDb().collection('attendance').orderBy('date', 'desc');
  if (startDate) q = q.where('date', '>=', firebase.firestore.Timestamp.fromDate(startDate));
  if (endDate)   q = q.where('date', '<=', firebase.firestore.Timestamp.fromDate(endDate));
  if (studentId) q = q.where('studentId', '==', studentId);
  const snap = await q.get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function deleteAttendance(id) {
  await getDb().collection('attendance').doc(id).delete();
}

// ─── Users / Mentors ──────────────────────────────────────────────────────────

// phone is the doc ID (normalised E.164)
async function createUserProfile(phone, data) {
  const normalised = normalizePhone(phone);
  await getDb().collection('users').doc(normalised).set({
    name:      data.name,
    phone:     normalised,
    role:      data.role,
    studentId: data.studentId || null,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

async function getUserByPhone(phone) {
  const normalised = normalizePhone(phone);
  const snap = await getDb().collection('users').doc(normalised).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function getMentors() {
  const snap = await getDb().collection('users')
    .where('role', '==', 'mentor').orderBy('name').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getActiveInstructors() {
  const all = await getMentors();
  return all.filter(m => (m.status || 'active') === 'active');
}

async function createMentor(name, phone, joiningDate) {
  const normalised = normalizePhone(phone);
  const existing = await getDb().collection('users').doc(normalised).get();
  if (existing.exists) throw new Error('This phone number is already registered.');
  await getDb().collection('users').doc(normalised).set({
    name,
    phone:       normalised,
    role:        'mentor',
    studentId:   null,
    status:      'active',
    joiningDate: joiningDate
      ? firebase.firestore.Timestamp.fromDate(new Date(joiningDate))
      : firebase.firestore.Timestamp.now(),
    createdAt:   firebase.firestore.FieldValue.serverTimestamp()
  });
}

async function setMentorStatus(phone, status) {
  const normalised = normalizePhone(phone);
  await getDb().collection('users').doc(normalised).update({ status });
}

async function deleteMentor(phone) {
  const normalised = normalizePhone(phone);
  await getDb().collection('users').doc(normalised).delete();
}

async function completeMentorProfile(phone, name) {
  const normalised = normalizePhone(phone);
  await getDb().collection('users').doc(normalised).update({ name });
}

async function completeStudentProfile(studentId, phone, data) {
  const db = getDb();
  const batch = db.batch();
  const fields = { ...data };
  if (fields.dob && !(fields.dob instanceof firebase.firestore.Timestamp)) {
    fields.dob = firebase.firestore.Timestamp.fromDate(new Date(fields.dob));
  }
  batch.update(db.collection('students').doc(studentId), fields);
  batch.update(db.collection('users').doc(phone), { name: data.name });
  await batch.commit();
}

async function updateStudentPhoto(studentId, photoDataURL) {
  await getDb().collection('students').doc(studentId).update({ photoURL: photoDataURL });
}

// ─── Referrals ────────────────────────────────────────────────────────────────

async function createReferral({ referrerId, referrerId_enrollmentNo, referrerName, referredId, referredName }) {
  const db = getDb();
  const referred = await getStudent(referredId);
  if (!referred) throw new Error('Referred student not found');

  const discountedTotal = referred.totalFee - REFERRAL_DISCOUNT_PAISE;
  const newBalance      = discountedTotal   - referred.paidFee;

  const batch = db.batch();

  const refRef = db.collection('referrals').doc();
  batch.set(refRef, {
    referrerId,
    referrerId_enrollmentNo,
    referrerName,
    referredId,
    referredName,
    rewardAmount:   REFERRAL_REWARD_PAISE,
    discountAmount: REFERRAL_DISCOUNT_PAISE,
    status:         'pending',
    createdAt:      firebase.firestore.FieldValue.serverTimestamp(),
    triggeredAt:    null,
    paidAt:         null
  });

  batch.update(db.collection('students').doc(referredId), {
    totalFee:        discountedTotal,
    balance:         newBalance,
    referralApplied: true,
    referredBy:      referrerId
  });

  await batch.commit();
  return refRef.id;
}

async function getReferrals() {
  const snap = await getDb().collection('referrals')
    .orderBy('createdAt', 'desc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function logReferralVisit(refCode) {
  const referrer = await getStudentByEnrollment(refCode);
  if (!referrer) return null;
  await getDb().collection('referralVisits').add({
    refCode,
    referrerId:   referrer.id,
    referrerName: referrer.name,
    enrollmentNo: referrer.enrollmentNumber,
    clickedAt:    firebase.firestore.FieldValue.serverTimestamp()
  });
  return referrer;
}

async function getReferralVisits() {
  const snap = await getDb().collection('referralVisits')
    .orderBy('clickedAt', 'desc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function markReferralPaid(referralId) {
  await getDb().collection('referrals').doc(referralId).update({
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

  batch.set(db.collection('feeAdjustments').doc(), {
    studentId,
    studentName:      student.name,
    enrollmentNumber: student.enrollmentNumber,
    oldTotal,
    newTotal,
    note:        note || '',
    adjustedAt:  firebase.firestore.FieldValue.serverTimestamp()
  });

  batch.update(db.collection('students').doc(studentId), {
    totalFee: newTotal,
    balance:  newTotal - student.paidFee
  });

  await batch.commit();
}

async function getFeeAdjustments(studentId) {
  const snap = await getDb().collection('feeAdjustments')
    .where('studentId', '==', studentId)
    .orderBy('adjustedAt', 'desc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ─── Driving Tests ───────────────────────────────────────────────────────────

async function scheduleDrivingTest(studentId, { scheduledAt, venue, notes }) {
  const db      = getDb();
  const student = await getStudent(studentId);
  if (!student) throw new Error('Student not found');
  const ref = await db.collection('drivingTests').add({
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
  await getDb().collection('drivingTests').doc(testId).update(data);
}

async function deleteDrivingTest(testId) {
  await getDb().collection('drivingTests').doc(testId).delete();
}

async function getAllDrivingTests() {
  const snap = await getDb().collection('drivingTests').orderBy('scheduledAt', 'asc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getStudentDrivingTests(studentId) {
  const snap = await getDb().collection('drivingTests')
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
  const snap  = await getDb().collection('drivingTests')
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
  const snap = await getDb().collection('students')
    .where('balance', '>', 0)
    .where('status', '==', 'active')
    .orderBy('balance', 'desc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ─── Vehicle Classes ──────────────────────────────────────────────────────────

async function getVehicleClasses() {
  const snap = await getDb().collection('vehicleClasses').orderBy('name').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function addVehicleClass(name) {
  const db = getDb();
  const n  = name.trim().toUpperCase();
  if (!n) throw new Error('Vehicle class name cannot be empty.');
  const snap = await db.collection('vehicleClasses').where('name', '==', n).limit(1).get();
  if (!snap.empty) throw new Error('Vehicle class already exists.');
  await db.collection('vehicleClasses').add({ name: n, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
}

async function deleteVehicleClass(id) {
  await getDb().collection('vehicleClasses').doc(id).delete();
}

// ─── DL Issuing Authorities ───────────────────────────────────────────────────

async function getDLAuthorities() {
  const snap = await getDb().collection('dlAuthorities').orderBy('name').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function addDLAuthority(name) {
  const db = getDb();
  const n  = name.trim().toUpperCase();
  if (!n) throw new Error('Authority name cannot be empty.');
  const snap = await db.collection('dlAuthorities').where('name', '==', n).limit(1).get();
  if (!snap.empty) throw new Error('Authority already exists.');
  await db.collection('dlAuthorities').add({ name: n, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
}

async function deleteDLAuthority(id) {
  await getDb().collection('dlAuthorities').doc(id).delete();
}

// ─── Training Vehicles ────────────────────────────────────────────────────────

async function getTrainingVehicles() {
  const snap = await getDb().collection('trainingVehicles').orderBy('regNo').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function addTrainingVehicle(regNo, description) {
  const n = regNo.trim().toUpperCase();
  if (!n) throw new Error('Registration number cannot be empty.');
  const snap = await getDb().collection('trainingVehicles').where('regNo', '==', n).limit(1).get();
  if (!snap.empty) throw new Error('This vehicle is already in the list.');
  await getDb().collection('trainingVehicles').add({
    regNo: n,
    description: (description || '').trim(),
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

async function deleteTrainingVehicle(id) {
  await getDb().collection('trainingVehicles').doc(id).delete();
}

// ─── Roster ───────────────────────────────────────────────────────────────────

async function getRosterSlots(weekStart) {
  const snap = await getDb().collection('rosterSlots')
    .where('weekStart', '==', weekStart)
    .orderBy('date').orderBy('instructorName').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function addRosterSlot({ weekStart, date, instructorPhone, instructorName, studentId, studentName, enrollmentNumber }) {
  const existing = await getDb().collection('rosterSlots')
    .where('weekStart', '==', weekStart)
    .where('date', '==', date)
    .where('studentId', '==', studentId).limit(1).get();
  if (!existing.empty) throw new Error(`${studentName} is already on the roster for this day.`);
  await getDb().collection('rosterSlots').add({
    weekStart, date, instructorPhone, instructorName,
    studentId, studentName, enrollmentNumber,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

async function deleteRosterSlot(id) {
  await getDb().collection('rosterSlots').doc(id).delete();
}

async function clearRosterWeek(weekStart) {
  const snap = await getDb().collection('rosterSlots').where('weekStart', '==', weekStart).get();
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
      const ref = getDb().collection('rosterSlots').doc();
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

