'use strict';

const https = require('https');
const { GoogleAuth } = require('google-auth-library'); // top-level v10 — uses embedded correct token URL
const env = require('../config/env');
const logger = require('../utils/logger');
const { optimizeImage, extensionFor } = require('./imageOptimizer');

let _googleAuth = null;

function getGoogleAuth() {
  if (_googleAuth) return _googleAuth;
  // FIREBASE_SERVICE_ACCOUNT is either a file path (local dev) or a JSON string
  // (Docker / Render). Mirror the dual handling in firebaseAdmin.js.
  const val = env.FIREBASE_SERVICE_ACCOUNT.trim();
  let sa = (val.startsWith('/') || val.startsWith('.')) ? require(val) : JSON.parse(val);
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

async function uploadToPath(fileBuffer, mimeType, filePath) {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET
    || `${env.firebaseProjectId}.firebasestorage.app`;

  const client = await getGoogleAuth().getClient();
  const { token: accessToken } = await client.getAccessToken();

  const boundary = `boundary${Date.now()}`;
  // Every upload gets a content-unique filename (Date.now()-random for images,
  // timestamped path for POS PDFs), so a given URL never changes content — it's
  // safe to cache it forever. This lets browsers/CDNs serve repeat views without
  // re-hitting the bucket, which is the main lever on Storage egress cost.
  const metadataJson = JSON.stringify({
    name: filePath,
    contentType: mimeType,
    cacheControl: 'public, max-age=31536000, immutable',
  });

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

  return `https://storage.googleapis.com/${bucketName}/${filePath}`;
}

// Image entry point: resizes and re-encodes before storing. uploadToPath stays
// byte-exact for non-image callers (POS quotation PDFs).
async function uploadToFirebase(fileBuffer, mimeType, folder) {
  const result = await optimizeImage(fileBuffer, mimeType, folder);

  if (result.optimized) {
    logger.info({
      folder,
      bytesBefore: result.bytesBefore,
      bytesAfter: result.bytesAfter,
      width: result.width,
      sourceType: mimeType,
    }, '[Storage] image optimized');
  } else if (result.reason !== 'no-gain' && result.reason !== 'already-optimized') {
    // 'no-gain' and 'already-optimized' are normal outcomes for a well-formed
    // upload. Anything else (a decode failure, an unexpected type) means this
    // object skipped the size reduction entirely — not fatal, we still store the
    // original, but worth seeing.
    logger.warn({ folder, sourceType: mimeType, reason: result.reason },
      '[Storage] image left unoptimized');
  }

  const ext = extensionFor(result.mimeType);
  const filename = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  return uploadToPath(result.buffer, result.mimeType, filename);
}

module.exports = { uploadToFirebase, uploadToPath };
