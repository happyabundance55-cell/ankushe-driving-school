// ─── Firebase Storage helpers for student photos ──────────────────────────────
// Compresses images client-side before upload to keep Storage usage low.

// Resize + compress to JPEG. maxWidth=800, quality=0.75 gives ~50–150 KB typical.
async function compressImage(file, maxWidth = 800, quality = 0.75) {
  return new Promise(resolve => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale   = Math.min(1, maxWidth / img.width);
      const canvas  = document.createElement('canvas');
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => resolve(blob), 'image/jpeg', quality);
    };
    img.src = objectUrl;
  });
}

// Compress then upload. Returns { url, storagePath }.
async function uploadStudentPhoto(file, enrollmentNumber, studentName) {
  const storage    = firebase.storage();
  const compressed = await compressImage(file);
  const safeName   = (studentName || 'student').replace(/[^a-zA-Z0-9_-]/g, '_');
  const path       = `student-photos/${enrollmentNumber}_${safeName}.jpg`;
  const ref        = storage.ref(path);
  await ref.put(compressed, { contentType: 'image/jpeg' });
  const url = await ref.getDownloadURL();
  return { url, storagePath: path };
}

async function deleteStudentPhoto(storagePath) {
  if (!storagePath) return;