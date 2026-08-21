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
 *   node scripts/rewrite-image-urls.js qa          # dry-run against qa
 *   node scripts/rewrite-image-urls.js qa --apply  # actually write
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// The environment is an explicit argument, never an ambient default. Reading
// .env.local unconditionally (as this script used to) silently targets dev even
// when you mean qa — the same cascade trap clear-rtdb-liveorders.js guards
// against. A --apply run against the wrong project is unrecoverable.
const ENV_FILES = {
  dev:  '.env.local.dev',
  qa:   '.env.local.qa',
  prod: '.env.local.prod',
};
const EXPECTED_PROJECT = {
  dev:  'suppliable-dev',
  qa:   'suppliable-qa-723f2',
  prod: 'suppliable-app',
};

const envName = (process.argv[2] || '').toLowerCase();
if (!ENV_FILES[envName]) {
  console.error('Usage: node scripts/rewrite-image-urls.js <dev|qa|prod> [--apply]');
  console.error('The environment is required — there is no default.');
  process.exit(1);
}

const envPath = path.join(__dirname, '..', ENV_FILES[envName]);
if (!fs.existsSync(envPath)) {
  console.error(`Missing env file: ${ENV_FILES[envName]}`);
  process.exit(1);
}
const cfg = dotenv.parse(fs.readFileSync(envPath));

const admin = require('firebase-admin');

const SA_PATH = cfg.FIREBASE_SERVICE_ACCOUNT;
const TARGET_BUCKET = cfg.FIREBASE_STORAGE_BUCKET;
if (!SA_PATH) throw new Error(`FIREBASE_SERVICE_ACCOUNT not set in ${ENV_FILES[envName]}`);
if (!TARGET_BUCKET) throw new Error(`FIREBASE_STORAGE_BUCKET not set in ${ENV_FILES[envName]}`);

const SOURCE_BUCKETS = [
  'suppliable-qa-723f2.firebasestorage.app',
  'suppliable-qa-723f2.appspot.com',
  'suppliable-app.firebasestorage.app',
  'suppliable-app.appspot.com',
].filter(b => b !== TARGET_BUCKET);

const COLLECTIONS = ['banners', 'categories', 'products', 'config'];
const APPLY = process.argv.includes('--apply');

const serviceAccount = require(path.isAbsolute(SA_PATH) ? SA_PATH : path.join(__dirname, '..', SA_PATH));
if (serviceAccount.project_id !== EXPECTED_PROJECT[envName]) {
  console.error(
    `FATAL: ${ENV_FILES[envName]} holds a service account for ` +
    `project_id=${serviceAccount.project_id}, but "${envName}" expects ` +
    `${EXPECTED_PROJECT[envName]}. Refusing to run.`
  );
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
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
  console.log(`Environment  : ${envName} (${ENV_FILES[envName]})`);
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
