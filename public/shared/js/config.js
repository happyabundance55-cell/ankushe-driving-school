// ─────────────────────────────────────────────────────────────────────────────
// SETUP — replace every YOUR_* value before deploying
// ─────────────────────────────────────────────────────────────────────────────
//
// Firebase:
//   1. Create project at https://console.firebase.google.com
//   2. Enable Firestore (start in production mode)
//   3. Enable Firebase Storage
//   4. Enable Firebase Hosting
//   5. Copy config from Project Settings → General → Your apps → Web app
//
// Firestore rules (permissive — no Firebase Auth):
//   rules_version = '2';
//   service cloud.firestore {
//     match /databases/{database}/documents {
//       match /{document=**} { allow read, write: if true; }
//     }
//   }
//
// Storage rules (permissive):
//   rules_version = '2';
//   service firebase.storage {
//     match /b/{bucket}/o {
//       match /{allPaths=**} { allow read, write: if true; }
//     }
//   }
//
// Google Drive archival (optional):
//   1. Go to https://console.cloud.google.com
//   2. Select the project linked to your Firebase project
//   3. Enable "Google Drive API"
//   4. Create OAuth 2.0 Client ID (Web application)
//   5. Add your hosting domain to "Authorized JavaScript origins"
//   6. Copy the Client ID below
//
// ─────────────────────────────────────────────────────────────────────────────

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyDE12jlkddl1ZK2ARPsU1KsNsPy4dInxF8",
  authDomain:        "ankushedrivingschool.firebaseapp.com",
  projectId:         "ankushedrivingschool",
  storageBucket:     "ankushedrivingschool.firebasestorage.app",
  messagingSenderId: "112479318857",
  appId:             "1:112479318857:web:36cc7085ca37edc1276098",
  measurementId:     "G-H5GXM1XRFB"
};

// Google OAuth Client ID — needed only for Drive photo archival
const GOOGLE_CLIENT_ID = "72338704829-paht04jv7godeufq85snl7brau3d998q.apps.googleusercontent.com";

// Google Drive folder names (used during archival)
const DRIVE_ROOT_FOLDER   = "Ankushe Driving School";
const DRIVE_PHOTOS_FOLDER = "Student Photos";

// Photos older than this many months get archived to Drive
const PHOTO_ARCHIVE_MONTHS = 5;

// Business constants
const APP_NAME                = "Ankushe Driving School";
const ENROLLMENT_PREFIX       = "DS";
const REFERRAL_DISCOUNT_PAISE = 20000;   // ₹200
const REFERRAL_REWARD_PAISE   = 20000;   // ₹200

// School details (used in government forms)
const SCHOOL_ADDRESS = "SR NO 38/A, KHARADKAR NAGAR, NEAR VINAYAK HOSPITAL WADGAONSHERI, PUNE CITY, PUNE, MH, 411014";

// Admin identity — the one Google account allowed admin access
const ADMIN_EMAIL = "ankushemds@gmail.com";
