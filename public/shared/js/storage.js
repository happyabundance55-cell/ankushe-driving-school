// ─── Photo storage (Cloudinary) ────────────────────────────────────────────────
// Compresses images client-side, then uploads via Cloudinary's unsigned upload
// API — no backend needed, and avoids Firebase Storage's Blaze-only requirement
// for newly-created projects. CLOUDINARY_CLOUD_NAME/UPLOAD_PRESET are in config.js.

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

// Compress then upload to Cloudinary, scoped under the tenant's own folder.
// Returns { url, publicId }. Old photos are left orphaned in Cloudinary when
// replaced (deleting requires a signed request we can't safely do client-side
// without a backend) — acceptable at this app's storage scale; a Phase-3
// cleanup can add a signed delete endpoint if that ever matters.
async function uploadStudentPhoto(file, tenantId, enrollmentNumber, studentName) {
  const compressed = await compressImage(file);
  const safeName    = (studentName || 'student').replace(/[^a-zA-Z0-9_-]/g, '_');
  const publicId     = `${enrollmentNumber}_${safeName}_${Date.now()}`;

  const formData = new FormData();
  formData.append('file', compressed, `${publicId}.jpg`);
  formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
  formData.append('folder', `tenants/${tenantId}/student-photos`);
  formData.append('public_id', publicId);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
    method: 'POST',
    body: formData
  });
  if (!res.ok) throw new Error('Photo upload failed. Try again.');
  const data = await res.json();
  return { url: data.secure_url, publicId: data.public_id };
}
