// ─────────────────────────────────────────────────────────────────────────────
// Shared Firebase project config for ALL tenants on Sarathi.
// Per-school settings (name, address, enrollment prefix, referral amounts, etc.)
// live in the `tenants/{tenantId}` Firestore doc — see shared/js/tenant.js.
// ─────────────────────────────────────────────────────────────────────────────

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyA_zwsy8928jfl7PBl4ojwePFIMtFQwpeM",
  authDomain:        "sarathi-driving-school.firebaseapp.com",
  projectId:         "sarathi-driving-school",
  messagingSenderId: "39366245999",
  appId:             "1:39366245999:web:cf8483f8390c5dfc5b579a"
};

// Cloudinary — student photo hosting (Firebase Storage requires Blaze on new
// projects; Cloudinary's free tier + unsigned uploads avoids that entirely).
// Upload preset name is safe to expose client-side by design (unsigned mode).
const CLOUDINARY_CLOUD_NAME    = "njyejfpa";
const CLOUDINARY_UPLOAD_PRESET = "sarathi_photos";
