// ─── Google Drive helpers — student photo storage + archival ─────────────────
// All student photos are stored directly in Google Drive.
// Drive OAuth uses Google Identity Services (GIS) — no Firebase Auth needed.

const DRIVE_API        = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

const _folderCache = {};

// Open the GIS consent popup to get a Drive OAuth token.
function requestDriveToken(onSuccess, onError) {
  if (typeof google === 'undefined' || !google.accounts) {
    onError(new Error('Google Identity Services not loaded.'));
    return;
  }
  google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope:     'https://www.googleapis.com/auth/drive.file',
    callback:  (resp) => {
      if (resp.access_token) {
        setDriveToken(resp.access_token);
        onSuccess(resp.access_token);
      } else {
        onError(new Error('Drive authorisation failed.'));
      }
    }
  }).requestAccessToken();
}

async function _driveRequest(url, options = {}) {
  const token = getDriveToken();
  if (!token) throw new Error('No Drive access token. Connect Google Drive first.');
  const res = await fetch(url, {
    ...options,
    headers: { 'Authorization': `Bearer ${token}`, ...(options.headers || {}) }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 401) { clearDriveToken(); throw new Error('Drive session expired. Reconnect.'); }
    throw new Error(err.error?.message || `Drive API error ${res.status}`);
  }
  return res.json();
}

async function _ensureFolder(name, parentId) {
  const cacheKey = `${parentId || 'root'}/${name}`;
  if (_folderCache[cacheKey]) return _folderCache[cacheKey];

  let query = `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false`;
  if (parentId) query += ` and '${parentId}' in parents`;

  const res = await _driveRequest(`${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id)`);
  if (res.files.length > 0) { _folderCache[cacheKey] = res.files[0].id; return res.files[0].id; }

  const body = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) body.parents = [parentId];
  const created = await _driveRequest(`${DRIVE_API}/files?fields=id`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body)
  });
  _folderCache[cacheKey] = created.id;
  return created.id;
}

async function _makePublic(fileId) {
  await _driveRequest(`${DRIVE_API}/files/${fileId}/permissions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ role: 'reader', type: 'anyone' })
  });
}

async function _uploadBlobToDrive(blob, fileName) {
  const rootId   = await _ensureFolder(DRIVE_ROOT_FOLDER, null);
  const folderId = await _ensureFolder(DRIVE_PHOTOS_FOLDER, rootId);

  const metadata = { name: fileName, parents: [folderId] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);

  const token = getDriveToken();
  const res = await fetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body:    form
  });
  if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error?.message || 'Drive upload failed'); }
  const data = await res.json();
  await _makePublic(data.id);
  return `https://drive.google.com/uc?export=view&id=${data.id}`;
}

// Archive one student's photo from Firebase Storage → Google Drive.
// Updates the student Firestore doc and deletes from Storage.
async function archiveStudentPhoto(student) {
  if (!student.photoURL || student.photoArchived) return;

  // Fetch blob from Firebase Storage download URL
  const resp = await fetch(student.photoURL);
  if (!resp.ok) throw new Error(`Could not fetch photo for ${student.name}`);
  const blob = await resp.blob();

  const safeName  = student.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName  = `${student.enrollmentNumber}_${safeName}.jpg`;
  const driveUrl  = await _uploadBlobToDrive(blob, fileName);

  // Update Firestore
  await getDb().collection('students').doc(student.id).update({
    photoURL:         driveUrl,
    photoStoragePath: '',
    photoArchived:    true
  });

  // Delete from Firebase Storage
  if (student.photoStoragePath) {
    await deleteStudentPhoto(student.photoStoragePath);
  }

  return driveUrl;
}

// Archive all students enrolled more than PHOTO_ARCHIVE_MONTHS months ago.
// Returns { archived, skipped, errors }.
async function archiveOldPhotos(onProgress) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - PHOTO_ARCHIVE_MONTHS);

  const snap = await getDb().collection('students')
    .where('photoArchived', '==', false)
    .where('enrollmentDate', '<=', firebase.firestore.Timestamp.fromDate(cutoff))
    .get();

  const candidates = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => s.photoURL);

  let archived = 0, skipped = 0, errors = [];

  for (const student of candidates) {
    try {
      await archiveStudentPhoto(student);
      archived++;
      if (onProgress) onProgress({ archived, skipped, errors, total: candidates.length });
    } catch (e) {
      errors.push(`${student.name}: ${e.message}`);
      skipped++;
    }
  }

  return { archived, skipped, errors, total: candidates.length };
}

// Resize + compress an image File to JPEG before uploading.
async function compressImage(file, maxWidth = 800, quality = 0.75) {
  return new Promise(resolve => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => resolve(blob), 'image/jpeg', quality);
    };
    img.src = objectUrl;
  });
}

// Compress a File and upload it to Drive. Returns the public URL.
// Throws if the Drive token is missing (admin needs to re-login with Google).
async function uploadPhotoToDrive(file, enrollmentNumber, studentName) {
  if (!getDriveToken()) throw new Error('Drive not connected. Please re-login as Admin using Google Sign-in to enable photo uploads.');
  const compressed = await compressImage(file);
  const safeName   = (studentName || 'student').replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName   = `${enrollmentNumber || 'NEW'}_${safeName}.jpg`;
  return _uploadBlobToDrive(compressed, fileName);
}
