'use strict';

const https = require('https');
const { GoogleAuth } = require('google-auth-library'); // top-level v10 — uses embedded correct token URL
const env = require('../config/env');

let _googleAuth = null;

function getGoogleAuth() {
  if (_googleAuth) return _googleAuth;
  let sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT.trim());
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  _googleAuth = new GoogleAuth({
    credentials: sa,
    scopes: ['https://www.googleapis.com/auth/devstorage.full_control'],
  });
  return _googleAuth;
}

function httpsPost(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(text);
        } else {
          reject(new Error(`GCS upload failed ${res.statusCode}: ${text}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function uploadToFirebase(fileBuffer, mimeType, folder) {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET
    || `${env.firebaseProjectId}.firebasestorage.app`;

  const client = await getGoogleAuth().getClient();
  const { token: accessToken } = await client.getAccessToken();

  const ext = (mimeType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const filename = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const boundary = `boundary${Date.now()}`;
  const metadataJson = JSON.stringify({ name: filename, contentType: mimeType });

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataJson}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    fileBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  await httpsPost(
    {
      hostname: 'storage.googleapis.com',
      path: `/upload/storage/v1/b/${encodeURIComponent(bucketName)}/o?uploadType=multipart&predefinedAcl=publicRead`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    },
    body
  );

  return `https://storage.googleapis.com/${bucketName}/${filename}`;
}

module.exports = { uploadToFirebase };
