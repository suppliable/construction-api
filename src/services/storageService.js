const admin = require('firebase-admin');

async function uploadToFirebase(fileBuffer, mimeType, folder) {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET
    || 'suppliable-app.firebasestorage.app';

  console.log('[Storage] Using bucket:', bucketName);

  const bucket = admin.storage().bucket(bucketName);

  const ext = (mimeType.split('/')[1] || 'jpg')
    .replace('jpeg', 'jpg');
  const filename = `${folder}/${Date.now()}-${Math.random()
    .toString(36).slice(2)}.${ext}`;
  const file = bucket.file(filename);

  await file.save(fileBuffer, {
    metadata: { contentType: mimeType },
    public: true,
    resumable: false
  });

  return `https://storage.googleapis.com/${bucketName}/${filename}`;
}

module.exports = { uploadToFirebase };
