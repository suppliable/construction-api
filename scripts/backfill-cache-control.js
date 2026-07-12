'use strict';

/**
 * backfill-cache-control.js
 *
 * Sets `Cache-Control: public, max-age=31536000, immutable` on existing Storage
 * objects so browsers/CDNs can serve repeat views without re-hitting the bucket.
 *
 * Why: images were uploaded without a Cache-Control header, so every view was a
 * fresh GCS egress hit (no client/CDN caching). New uploads now set the header
 * in storageService.js; this script backfills everything already in the bucket.
 *
 * Safe because every object has a content-unique name (Date.now()-random for
 * images, timestamped path for POS PDFs) — a given URL never changes content,
 * so caching it forever can't serve a stale image.
 *
 * Idempotent. Skips objects that already carry the target header, so re-running
 * only touches what's left. Only patches metadata — never re-uploads bytes, so
 * it costs Class A ops, not egress.
 *
 * Targets the bucket in FIREBASE_STORAGE_BUCKET (from .env.local). To backfill
 * prod, point .env.local at the prod SA/bucket (or run with a prod .env).
 *
 * Usage:
 *   cd construction-api
 *   node scripts/backfill-cache-control.js          # dry-run
 *   node scripts/backfill-cache-control.js --apply   # actually write
 *   node scripts/backfill-cache-control.js --apply --prefix products/
 */

const path = require('path');
// override: true so a stale shell export (e.g. FIREBASE_SERVICE_ACCOUNT pointing
// at a different project's SA) doesn't silently take precedence over .env.local.
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });

const admin = require('firebase-admin');

const SA_PATH = process.env.FIREBASE_SERVICE_ACCOUNT;
const BUCKET = process.env.FIREBASE_STORAGE_BUCKET;
if (!SA_PATH) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
if (!BUCKET) throw new Error('FIREBASE_STORAGE_BUCKET not set');

const TARGET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const APPLY = process.argv.includes('--apply');
const prefixArg = process.argv.indexOf('--prefix');
const PREFIX = prefixArg !== -1 ? process.argv[prefixArg + 1] : undefined;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require(SA_PATH)),
    storageBucket: BUCKET,
  });
}
const bucket = admin.storage().bucket();

async function main() {
  console.log(`Bucket: ${BUCKET}`);
  console.log(`Prefix: ${PREFIX || '(all objects)'}`);
  console.log(`Target: Cache-Control: ${TARGET_CACHE_CONTROL}`);
  console.log(`Mode:   ${APPLY ? 'APPLY (metadata will be written)' : 'DRY-RUN (no writes)'}`);
  console.log('');

  const [files] = await bucket.getFiles(PREFIX ? { prefix: PREFIX } : {});
  let already = 0;
  let toPatch = 0;
  let patched = 0;
  let failed = 0;

  for (const file of files) {
    // getFiles already returns metadata, so no extra GET per object.
    const current = file.metadata && file.metadata.cacheControl;
    if (current === TARGET_CACHE_CONTROL) {
      already++;
      continue;
    }
    toPatch++;
    if (!APPLY) {
      console.log(`  would set  ${file.name}  (was: ${current || 'none'})`);
      continue;
    }
    try {
      await file.setMetadata({ cacheControl: TARGET_CACHE_CONTROL });
      patched++;
      if (patched % 100 === 0) console.log(`  ...patched ${patched}`);
    } catch (e) {
      failed++;
      console.error(`  FAILED ${file.name}: ${e.message}`);
    }
  }

  console.log('');
  console.log(`Total objects:      ${files.length}`);
  console.log(`Already correct:    ${already}`);
  console.log(`${APPLY ? 'Patched' : 'Would patch'}:  ${APPLY ? patched : toPatch}`);
  if (APPLY && failed) console.log(`Failed:             ${failed}`);
  if (!APPLY && toPatch > 0) console.log('\nRe-run with --apply to commit.');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
