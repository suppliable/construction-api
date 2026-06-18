const admin = require('firebase-admin');
const env = require('../config/env');

function isStaleConnectionError(err) {
  const msg = err?.message || '';
  return msg.includes('Premature close') || msg.includes('Invalid response body') || msg.includes('ECONNRESET');
}

async function uploadToFirebase(fileBuffer, mimeType, folder, _attempt = 0) {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET
    || `${env.firebaseProjectId}.firebasestorage.app`;

  console.log(`[Storage] attempt=${_attempt} bucket=${bucketName} folder=${folder}`);
  const bucket = admin.storage().bucket(bucketName);

  const ext = (mimeType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const filename = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const file = bucket.file(filename);

  try {
    await file.save(fileBuffer, {
      metadata: { contentType: mimeType },
      public: true,
      resumable: false,
    });
  } catch (err) {
    console.error(`[Storage] upload failed attempt=${_attempt} bucket=${bucketName}:`, err.message);
    // Stale connection in the undici pool — retry once with a fresh connection.
    if (_attempt === 0 && isStaleConnectionError(err)) {
      return uploadToFirebase(fileBuffer, mimeType, folder, 1);
    }
    throw err;
  }

  return `https://storage.googleapis.com/${bucketName}/${filename}`;
}

module.exports = { uploadToFirebase };
