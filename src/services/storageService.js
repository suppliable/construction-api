'use strict';

const { Storage } = require('@google-cloud/storage');
const env = require('../config/env');

let _storage = null;

function getStorageClient() {
  if (_storage) return _storage;

  let sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT.trim());
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');

  _storage = new Storage({
    projectId: sa.project_id || env.firebaseProjectId,
    credentials: { ...sa, token_uri: 'https://oauth2.googleapis.com/token' },
  });

  return _storage;
}

async function uploadToFirebase(fileBuffer, mimeType, folder) {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET
    || `${env.firebaseProjectId}.firebasestorage.app`;

  const bucket = getStorageClient().bucket(bucketName);

  const ext = (mimeType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const filename = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const file = bucket.file(filename);

  await file.save(fileBuffer, {
    metadata: { contentType: mimeType },
    public: true,
    resumable: false,
  });

  return `https://storage.googleapis.com/${bucketName}/${filename}`;
}

module.exports = { uploadToFirebase };
