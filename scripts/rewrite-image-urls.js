'use strict';

/**
 * rewrite-image-urls.js
 *
 * Scans Firestore for any string field containing a non-target Storage bucket
 * hostname and rewrites it to the active project's bucket.
 *
 * Why: when we import catalog docs from one Firebase project into another
 * (e.g. qa → dev), the imported docs carry absolute imageUrl fields that
 * point at the source bucket. The image files themselves are gsutil-rsynced
 * into the target bucket, but the docs still reference the source. This
 * script rewrites those references in place.
 *
 * Targets (from env):
 *   - source: every host listed in SOURCE_BUCKETS (default: all known non-dev)
 *   - target: FIREBASE_STORAGE_BUCKET (from .env.local)
 *
 * Idempotent. Safe to re-run — second run will find nothing to change.
 *
 * Usage:
 *   cd construction-api
 *   node scripts/rewrite-image-urls.js          # dry-run
 *   node scripts/rewrite-image-urls.js --apply  # actually write
 */

const path = require('path');
// override: true so a stale shell export (e.g. FIREBASE_SERVICE_ACCOUNT pointing
// at a different project's SA) doesn't silently take precedence over .env.local.
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });

const admin = require('firebase-admin');

const SA_PATH = process.env.FIREBASE_SERVICE_ACCOUNT;
const TARGET_BUCKET = process.env.FIREBASE_STORAGE_BUCKET;
if (!SA_PATH) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
if (!TARGET_BUCKET) throw new Error('FIREBASE_STORAGE_BUCKET not set');

const SOURCE_BUCKETS = [
  'suppliable-qa-723f2.firebasestorage.app',
  'suppliable-qa-723f2.appspot.com',
  'suppliable-app.firebasestorage.app',
  'suppliable-app.appspot.com',
].filter(b => b !== TARGET_BUCKET);

const COLLECTIONS = ['banners', 'categories', 'products', 'config'];
const APPLY = process.argv.includes('--apply');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(require(SA_PATH)) });
}
const db = admin.firestore();

function rewriteValue(value) {
  if (typeof value !== 'string') return { value, changed: false };
  let next = value;
  let changed = false;
  for (const src of SOURCE_BUCKETS) {
    if (next.includes(src)) {
      next = next.split(src).join(TARGET_BUCKET);
      changed = true;
    }
  }
  return { value: next, changed };
}

function rewriteFields(obj) {
  let changed = false;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') {
      const inner = rewriteFields(v);
      out[k] = inner.value;
      if (inner.changed) changed = true;
    } else {
      const r = rewriteValue(v);
      out[k] = r.value;
      if (r.changed) changed = true;
    }
  }
  return { value: out, changed };
}

async function scanCollection(name) {
  const snap = await db.collection(name).get();
  const updates = [];
  for (const doc of snap.docs) {
    const r = rewriteFields(doc.data());
    if (r.changed) updates.push({ ref: doc.ref, before: doc.data(), after: r.value });
  }
  return updates;
}

async function main() {
  console.log(`Target bucket: ${TARGET_BUCKET}`);
  console.log(`Looking for references to: ${SOURCE_BUCKETS.join(', ')}`);
  console.log(`Mode: ${APPLY ? 'APPLY (writes will happen)' : 'DRY-RUN (no writes)'}`);
  console.log('');

  let totalChanged = 0;
  for (const col of COLLECTIONS) {
    const updates = await scanCollection(col);
    console.log(`[${col}] ${updates.length} doc(s) need rewriting`);
    for (const u of updates) {
      console.log(`  - ${u.ref.id}`);
    }
    if (APPLY && updates.length > 0) {
      const batch = db.batch();
      for (const u of updates) batch.set(u.ref, u.after, { merge: false });
      await batch.commit();
      console.log(`  → wrote ${updates.length} doc(s)`);
    }
    totalChanged += updates.length;
  }

  console.log('');
  console.log(`Total ${APPLY ? 'rewritten' : 'would rewrite'}: ${totalChanged}`);
  if (!APPLY && totalChanged > 0) console.log('Re-run with --apply to commit.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
