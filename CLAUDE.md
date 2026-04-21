Terse like caveman. Technical substance exact. Only fluff die.
Drop: articles, filler (just/really/basically), pleasantries, hedging.
Fragments OK. Short synonyms. Code unchanged.
Pattern: [thing] [action] [reason]. [next step].
ACTIVE EVERY RESPONSE. No revert after many turns.
Code/commits/PRs: normal. Off: "stop caveman" / "normal mode".


# Driving School Management App

## What this project is
A web app to run a driving school end-to-end: student records, fees, attendance, reporting, and WhatsApp-based communication. Owner-operated, small-to-mid scale.

The signature flow: **student signs in from inside the vehicle at the start of a lesson** — this is how attendance is confirmed, not a manual admin entry.

## Stack
- **Frontend:** Plain HTML / CSS / vanilla JS (no framework)
- **Backend:** Firebase
  - **Auth:** Firebase Auth — phone/OTP for students, email+password for mentors, Google Sign-in for admin (gives Drive access)
  - **Database:** Firestore
  - **Hosting:** Firebase Hosting
- **File storage:** Google Drive (student photos) via OAuth access token obtained at admin login
- **Currency:** INR throughout, stored as paise (integers)

## User roles
- **Admin (owner):** Full access — enrollments, fees, reports, referrals, attendance
- **Mentor:** Attendance marking, student lookup
- **Student:** Login from vehicle, sign lesson, view own balance

## File structure
```
/public
  index.html          — redirect based on role
  login.html          — unified login (student phone OTP / staff email-pw / admin Google)
  setup.html          — first-run admin account creation
  /shared
    /css/main.css
    /js/config.js     — Firebase + Google config (EDIT BEFORE DEPLOY)
        auth.js       — auth state helpers, requireAuth(), setDriveToken()
        db.js         — ALL Firestore operations (never scatter db.collection() calls)
        drive.js      — Google Drive upload helpers
        utils.js      — formatCurrency, formatDate, initSignaturePad, printElement, etc.
  /admin
    dashboard.html    — revenue dashboard with period comparison bar chart
    students.html     — student list with search/filter
    student-form.html — create / edit student (photo upload to Drive)
    student-profile.html — full printable profile
    attendance.html   — mark + list + print attendance
    fees.html         — record payments, view balances
    referrals.html    — track and pay out referral rewards
  /student
    dashboard.html    — balance, attendance count, payment history
    sign.html         — in-vehicle signature attendance
```

## Data model (Firestore collections)
- `students` — name, phone, address, enrollmentNumber, enrollmentDate, photoFileId, photoURL, totalFee(paise), paidFee(paise), balance(paise), referredBy, referralApplied, status
- `payments` — studentId, amount(paise), method, note, date
- `attendance` — studentId, date, markedBy(uid), markedByRole, mentorName, signatureDataURL
- `users` — name, phone, email, role ('admin'|'mentor'|'student'), studentId
- `referrals` — referrerId, referrerId_enrollmentNo, referrerName, referredId, referredName, rewardAmount(paise), discountAmount(paise), status ('pending'→'triggered'→'paid')
- `counters/enrollmentNumber` — year, seq (for DS-2026-001 format)
- `counters/setup` — written on first-run to prevent repeated setup

## Conventions
- All Firestore writes go through functions in db.js — never scatter db.collection() calls across pages
- Dates stored as Firestore Timestamps, displayed as `DD MMM YYYY` in UI
- Money stored as paise (integer), displayed with formatCurrency() → ₹X,XX,XXX
- Enrollment numbers: DS-YYYY-NNN (e.g. DS-2026-001), auto-generated transactionally
- Phone numbers stored with country code (+91...)

## Referral system
- Set at enrollment time via student-form.html
- Referred student immediately gets ₹200 discount on total fee
- When referred student records first payment → referral status moves to 'triggered'
- Admin manually pays ₹200 cash and marks as paid in referrals.html

## Google Drive integration
- Admin must sign in with Google Sign-in (login page, "Admin" tab) to get Drive access token
- Token stored in sessionStorage as 'driveToken' (expires after ~1 hour — re-auth if upload fails)
- Photos uploaded to: "Ankushe Driving School / Student Photos" folder in admin's Drive
- Files made publicly viewable after upload; URLs stored in students.photoURL
- Mentors and students do NOT use Drive (signatures stored as base64 in Firestore)

## Print features
- Student profile: window.print() — prints full profile including photo, fee summary, attendance table
- Attendance: window.print() — prints filtered attendance list with date/time/mentor
- CSS @media print hides nav, buttons, forms; shows .print-header

## Don't do
- Don't introduce React, Vue, or any framework — stack stays plain JS
- Don't use localStorage for anything that needs to persist reliably — use Firestore
- Don't hardcode WhatsApp message text in JS (WhatsApp not yet built — open question)
- Don't auto-generate enrollment numbers as random strings — use DS-YYYY-NNN
- Don't build features not listed here without asking first

## Setup checklist (before first deploy)
1. Create Firebase project, enable Auth (Email/Password + Phone + Google), Firestore, Hosting
2. Create Google Cloud OAuth 2.0 Client ID with drive.file scope, add hosting domain to allowed origins
3. Edit `public/shared/js/config.js` — replace all YOUR_* values
4. Edit `.firebaserc` — replace YOUR_FIREBASE_PROJECT_ID
5. `firebase deploy`
6. Open the app → sign in with Google → you'll be redirected to setup.html → create admin account

## Open questions / to decide
- WhatsApp gateway choice (WhatsApp Business API vs AiSensy / Interakt / Wati)
- Whether mentors get individual logins (currently yes, email+password, created via Firebase Console)
- Backup/export cadence for student records (Excel export not yet built)
- Whether to add bulk attendance marking for a vehicle/session

## Current focus
- Core app is built and ready for Firebase deployment
- Next: Firebase project setup, deploy, first-run test
