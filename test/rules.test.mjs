// Security-rules test suite, run against the Firestore emulator.
// Usage: firebase emulators:exec --only firestore "node test/rules.test.mjs"
import { readFileSync } from 'fs';
import assert from 'node:assert/strict';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails
} from '@firebase/rules-unit-testing';

const rules = readFileSync('firestore.rules', 'utf8');

let passed = 0, failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  - ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL  - ${name}`);
    console.log(`        ${e.message}`);
    failed++;
  }
}

const testEnv = await initializeTestEnvironment({
  projectId: 'sarathi-rules-test',
  firestore: { rules, host: '127.0.0.1', port: 8080 }
});

async function seed(fn) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => fn(ctx.firestore()));
}

// ── Fixtures: two tenants, each with an admin/mentor/student ───────────────
const T1 = 't1', T2 = 't2';
const admin1 = 'uidAdmin1', mentor1 = 'uidMentor1', student1 = 'uidStudent1';
const admin2 = 'uidAdmin2';
const sid1 = 'sidStudent1', sid2 = 'sidStudent2';

await seed(async (db) => {
  await db.doc(`tenants/${T1}`).set({ ownerUid: admin1, name: 'Tenant One' });
  await db.doc(`tenants/${T2}`).set({ ownerUid: admin2, name: 'Tenant Two' });
  await db.doc(`users/${admin1}`).set({ tenantId: T1, role: 'admin', name: 'Admin One' });
  await db.doc(`users/${mentor1}`).set({ tenantId: T1, role: 'mentor', name: 'Mentor One', phone: '+911111111111' });
  await db.doc(`users/${student1}`).set({ tenantId: T1, role: 'student', studentId: sid1, phone: '+912222222222' });
  await db.doc(`users/${admin2}`).set({ tenantId: T2, role: 'admin', name: 'Admin Two' });
  await db.doc(`tenants/${T1}/students/${sid1}`).set({ name: 'Student One', phone: '+912222222222' });
  await db.doc(`tenants/${T2}/students/${sid2}`).set({ name: 'Student Two', phone: '+913333333333' });
});

console.log('\n=== Tenant doc readability ===');

await check('unauthenticated visitor CAN read a tenant doc (needed for login.html branding pre-auth)', async () => {
  const db = testEnv.unauthenticatedContext().firestore();
  await assertSucceeds(db.doc(`tenants/${T1}`).get());
});

await check('unauthenticated visitor still CANNOT read students in that tenant', async () => {
  const db = testEnv.unauthenticatedContext().firestore();
  await assertFails(db.doc(`tenants/${T1}/students/${sid1}`).get());
});

console.log('\n=== Tenant isolation ===');

await check('T1 admin can read T1 student', async () => {
  const db = testEnv.authenticatedContext(admin1).firestore();
  await assertSucceeds(db.doc(`tenants/${T1}/students/${sid1}`).get());
});

await check('T1 admin CANNOT read T2 student', async () => {
  const db = testEnv.authenticatedContext(admin1).firestore();
  await assertFails(db.doc(`tenants/${T2}/students/${sid2}`).get());
});

await check('T1 mentor CANNOT read T2 student', async () => {
  const db = testEnv.authenticatedContext(mentor1).firestore();
  await assertFails(db.doc(`tenants/${T2}/students/${sid2}`).get());
});

await check('T1 mentor CANNOT write T2 student', async () => {
  const db = testEnv.authenticatedContext(mentor1).firestore();
  await assertFails(db.doc(`tenants/${T2}/students/${sid2}`).update({ name: 'Hacked' }));
});

await check('T1 student can read own record', async () => {
  const db = testEnv.authenticatedContext(student1).firestore();
  await assertSucceeds(db.doc(`tenants/${T1}/students/${sid1}`).get());
});

await check('T1 student CANNOT read another student in same tenant', async () => {
  await seed(async (db) => db.doc(`tenants/${T1}/students/sidOther`).set({ name: 'Other', phone: '+919999999999' }));
  const db = testEnv.authenticatedContext(student1).firestore();
  await assertFails(db.doc(`tenants/${T1}/students/sidOther`).get());
});

await check('unauthenticated user CANNOT read any student', async () => {
  const db = testEnv.unauthenticatedContext().firestore();
  await assertFails(db.doc(`tenants/${T1}/students/${sid1}`).get());
});

console.log('\n=== Tenant self-provisioning (signup) ===');

await check('brand-new user can self-provision a brand-new tenant as admin', async () => {
  const uid = 'uidNewOwner';
  const db = testEnv.authenticatedContext(uid).firestore();
  const batch = db.batch();
  batch.set(db.doc('tenants/tNew'), { ownerUid: uid, name: 'New School' });
  batch.set(db.doc(`users/${uid}`), { tenantId: 'tNew', role: 'admin', name: 'New Owner' });
  await assertSucceeds(batch.commit());
});

await check('existing member CANNOT self-provision a second tenant', async () => {
  const db = testEnv.authenticatedContext(admin1).firestore();
  const batch = db.batch();
  batch.set(db.doc('tenants/tHijack1'), { ownerUid: admin1, name: 'Hijack' });
  batch.set(db.doc(`users/${admin1}`), { tenantId: 'tHijack1', role: 'admin', name: 'Admin One' });
  await assertFails(batch.commit());
});

await check('new user CANNOT claim an EXISTING tenant as their own admin', async () => {
  const uid = 'uidAttacker';
  const db = testEnv.authenticatedContext(uid).firestore();
  const batch = db.batch();
  // T1 already exists (seeded) — ownerUid mismatch AND tenant already exists.
  batch.set(db.doc(`tenants/${T1}`), { ownerUid: uid, name: 'Hijacked One' });
  batch.set(db.doc(`users/${uid}`), { tenantId: T1, role: 'admin', name: 'Attacker' });
  await assertFails(batch.commit());
});

console.log('\n=== Mentor invite linking ===');

await check('admin can create a pending invite for their own tenant', async () => {
  const db = testEnv.authenticatedContext(admin1).firestore();
  await assertSucceeds(db.doc('pendingInvites/+914444444444').set({ tenantId: T1, role: 'mentor', name: 'New Mentor' }));
});

await check('admin CANNOT create a pending invite for a different tenant', async () => {
  const db = testEnv.authenticatedContext(admin1).firestore();
  await assertFails(db.doc('pendingInvites/+915555555555').set({ tenantId: T2, role: 'mentor', name: 'Cross Tenant' }));
});

await check('mentor CANNOT create pending invites (not admin)', async () => {
  const db = testEnv.authenticatedContext(mentor1).firestore();
  await assertFails(db.doc('pendingInvites/+916666666666').set({ tenantId: T1, role: 'mentor', name: 'X' }));
});

await check('admin can read/list their own tenant\'s pending invites', async () => {
  const db = testEnv.authenticatedContext(admin1).firestore();
  await assertSucceeds(db.doc('pendingInvites/+914444444444').get());
  await assertSucceeds(db.collection('pendingInvites').where('tenantId', '==', T1).get());
});

await check('a different tenant\'s admin CANNOT read another tenant\'s pending invite', async () => {
  const db = testEnv.authenticatedContext(admin2).firestore();
  await assertFails(db.doc('pendingInvites/+914444444444').get());
});

await check('phone-verified user WITH matching invite can link mentor role', async () => {
  const uid = 'uidNewMentor';
  const phone = '+914444444444'; // matches invite created above
  const db = testEnv.authenticatedContext(uid, { phone_number: phone }).firestore();
  await assertSucceeds(db.doc(`users/${uid}`).set({ tenantId: T1, role: 'mentor', phone, name: 'New Mentor' }));
});

await check('phone-verified user WITHOUT matching invite CANNOT self-grant mentor role', async () => {
  const uid = 'uidNoInvite';
  const phone = '+917777777777';
  const db = testEnv.authenticatedContext(uid, { phone_number: phone }).firestore();
  await assertFails(db.doc(`users/${uid}`).set({ tenantId: T1, role: 'mentor', phone, name: 'Sneaky' }));
});

await check('user CANNOT claim mentor role for a phone that is not their verified token phone', async () => {
  const uid = 'uidSpoofer';
  const db = testEnv.authenticatedContext(uid, { phone_number: '+918888888888' }).firestore();
  // pretends to be the invited number, but token phone doesn't match
  await assertFails(db.doc(`users/${uid}`).set({ tenantId: T1, role: 'mentor', phone: '+914444444444', name: 'Spoofer' }));
});

console.log('\n=== Student self-serve signup ===');

await check('phone-verified user can self-register as a student in an existing tenant', async () => {
  const uid = 'uidNewStudent';
  const phone = '+919111111111';
  const db = testEnv.authenticatedContext(uid, { phone_number: phone }).firestore();
  const batch = db.batch();
  batch.set(db.doc(`tenants/${T1}/students/sidNewStudent`), { name: 'Fresh Student', phone });
  batch.set(db.doc(`users/${uid}`), { tenantId: T1, role: 'student', studentId: 'sidNewStudent', phone });
  await assertSucceeds(batch.commit());
});

await check('student self-serve CANNOT target a tenant that does not exist', async () => {
  const uid = 'uidGhostStudent';
  const phone = '+919222222222';
  const db = testEnv.authenticatedContext(uid, { phone_number: phone }).firestore();
  await assertFails(db.doc(`users/${uid}`).set({ tenantId: 'tGhost', role: 'student', phone }));
});

await check('user CANNOT self-register a student record with someone else\'s phone', async () => {
  const uid = 'uidImpersonator';
  const db = testEnv.authenticatedContext(uid, { phone_number: '+919333333333' }).firestore();
  await assertFails(db.doc(`tenants/${T1}/students/sidImpersonated`).set({ name: 'Fake', phone: '+912222222222' }));
});

console.log('\n=== Student linking (admin pre-enrolled, student links on first login) ===');

await check('admin-enrolled student can link on first OTP login (no duplicate student doc)', async () => {
  const sid = 'sidPreEnrolled';
  const phone = '+919444444444';
  await seed(async (db) => {
    await db.doc(`tenants/${T1}/students/${sid}`).set({ name: 'Pre Enrolled', phone });
    await db.doc(`tenants/${T1}/studentsByPhone/${phone}`).set({ studentId: sid });
  });
  const uid = 'uidLinkingStudent';
  const db = testEnv.authenticatedContext(uid, { phone_number: phone }).firestore();
  await assertSucceeds(db.doc(`users/${uid}`).set({ tenantId: T1, role: 'student', studentId: sid, phone }));
});

await check('user CANNOT link to a studentId that does not match the phone mapping', async () => {
  const phone = '+919555555555';
  await seed(async (db) => {
    await db.doc(`tenants/${T1}/students/sidReal`).set({ name: 'Real', phone });
    await db.doc(`tenants/${T1}/studentsByPhone/${phone}`).set({ studentId: 'sidReal' });
  });
  const uid = 'uidLinkForger';
  const db = testEnv.authenticatedContext(uid, { phone_number: phone }).firestore();
  // tries to attach itself to someone else's studentId instead of the one the mapping points at
  await assertFails(db.doc(`users/${uid}`).set({ tenantId: T1, role: 'student', studentId: sid1, phone }));
});

console.log('\n=== Referral banner (public-safe projection) ===');

await check('anyone can read a referralCodes entry (public banner lookup)', async () => {
  await seed(async (db) => db.doc(`tenants/${T1}/referralCodes/DS-2026-001`).set({ referrerName: 'Student One' }));
  const db = testEnv.unauthenticatedContext().firestore();
  await assertSucceeds(db.doc(`tenants/${T1}/referralCodes/DS-2026-001`).get());
});

await check('anyone CANNOT read the underlying students collection directly', async () => {
  const db = testEnv.unauthenticatedContext().firestore();
  await assertFails(db.collection(`tenants/${T1}/students`).get());
});

console.log('\n=== Billing fields (trial/plan/subscription) ===');

const superadmin = 'uidSuperadmin';
await seed(async (db) => {
  await db.doc(`tenants/${T1}`).set({
    ownerUid: admin1, name: 'Tenant One', plan: 'starter', billingStatus: 'trialing',
    studentCap: 30, waNotifications: false, referredByTenantId: null, referralCredited: false
  });
  await db.doc(`superadmins/${superadmin}`).set({ email: 'super@example.com' });
});

await check('tenant admin CAN still update non-billing settings (masters.html save)', async () => {
  const db = testEnv.authenticatedContext(admin1).firestore();
  await assertSucceeds(db.doc(`tenants/${T1}`).update({ name: 'Renamed School', sessionMins: 90 }));
});

await check('tenant admin CANNOT self-grant an active billing status', async () => {
  const db = testEnv.authenticatedContext(admin1).firestore();
  await assertFails(db.doc(`tenants/${T1}`).update({ billingStatus: 'active' }));
});

await check('tenant admin CANNOT extend their own trial', async () => {
  const db = testEnv.authenticatedContext(admin1).firestore();
  const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  await assertFails(db.doc(`tenants/${T1}`).update({ trialEndsAt: farFuture }));
});

await check('tenant admin CANNOT raise their own student cap', async () => {
  const db = testEnv.authenticatedContext(admin1).firestore();
  await assertFails(db.doc(`tenants/${T1}`).update({ studentCap: 999999 }));
});

await check('superadmin CAN update billing fields on any tenant', async () => {
  const db = testEnv.authenticatedContext(superadmin).firestore();
  await assertSucceeds(db.doc(`tenants/${T1}`).update({ billingStatus: 'active', plan: 'growth' }));
});

await check('non-superadmin CANNOT read another user\'s superadmins doc', async () => {
  const db = testEnv.authenticatedContext(admin1).firestore();
  await assertFails(db.doc(`superadmins/${superadmin}`).get());
});

await check('a user CAN read their own superadmins doc (self-check)', async () => {
  const db = testEnv.authenticatedContext(superadmin).firestore();
  await assertSucceeds(db.doc(`superadmins/${superadmin}`).get());
});

await check('nobody can client-write superadmins (seeded manually only)', async () => {
  const db = testEnv.authenticatedContext(superadmin).firestore();
  await assertFails(db.doc(`superadmins/${superadmin}`).set({ email: 'x' }));
});

await check('tenant admin CAN read their own subscriptionPayments', async () => {
  await seed(async (db) => db.doc(`tenants/${T1}/subscriptionPayments/order1`).set({ plan: 'starter', amountPaise: 59900 }));
  const db = testEnv.authenticatedContext(admin1).firestore();
  await assertSucceeds(db.doc(`tenants/${T1}/subscriptionPayments/order1`).get());
});

await check('tenant admin CANNOT write subscriptionPayments (Worker-only)', async () => {
  const db = testEnv.authenticatedContext(admin1).firestore();
  await assertFails(db.doc(`tenants/${T1}/subscriptionPayments/orderFake`).set({ plan: 'pro', amountPaise: 1 }));
});

await check('tenant admin CANNOT create a referralPayout for themselves', async () => {
  const db = testEnv.authenticatedContext(admin1).firestore();
  await assertFails(db.doc(`tenants/${T1}/referralPayouts/fake`).set({ amountPaise: 30000, status: 'pending' }));
});

await check('superadmin CAN mark a referralPayout paid', async () => {
  await seed(async (db) => db.doc(`tenants/${T1}/referralPayouts/payout1`).set({ amountPaise: 30000, status: 'pending', fromTenantId: T2 }));
  const db = testEnv.authenticatedContext(superadmin).firestore();
  await assertSucceeds(db.doc(`tenants/${T1}/referralPayouts/payout1`).update({ status: 'paid' }));
});

await check('tenant admin CANNOT mark their own referralPayout paid', async () => {
  const db = testEnv.authenticatedContext(admin1).firestore();
  await assertFails(db.doc(`tenants/${T1}/referralPayouts/payout1`).update({ status: 'paid' }));
});

console.log('\n=== Self-serve signup approval (status: pending) ===');

await check('self-serve signup can be created with status "pending" (approval gate)', async () => {
  const uid = 'uidPendingStudent';
  const phone = '+919666666666';
  const db = testEnv.authenticatedContext(uid, { phone_number: phone }).firestore();
  const batch = db.batch();
  batch.set(db.doc(`tenants/${T1}/students/sidPending`), { name: 'Pending Student', phone, status: 'pending', enrollmentNumber: '' });
  batch.set(db.doc(`users/${uid}`), { tenantId: T1, role: 'student', studentId: 'sidPending', phone });
  await assertSucceeds(batch.commit());
});

await check('a pending student can still read their own record (sees approval status)', async () => {
  const db = testEnv.authenticatedContext('uidPendingStudent').firestore();
  await assertSucceeds(db.doc(`tenants/${T1}/students/sidPending`).get());
});

await check('admin can approve a pending student (flip status to active + assign enrollment no)', async () => {
  const db = testEnv.authenticatedContext(admin1).firestore();
  await assertSucceeds(db.doc(`tenants/${T1}/students/sidPending`).update({ status: 'active', enrollmentNumber: 'DS-2026-099' }));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
await testEnv.cleanup();
if (failed > 0) process.exit(1);
