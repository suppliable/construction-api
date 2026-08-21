'use strict';
/**
 * restore-image-map.js
 *
 * Restores config/imageMap entries from a backup written by prune-dead-image-refs.js,
 * rewriting source-bucket hostnames to the target environment's bucket.
 *
 * Why this exists: prune-dead-image-refs.js treated HTTP 403 as "dead". A
 * cross-project Storage object answers 403 AccessDenied anonymously — it exists,
 * we just cannot read it without credentials. On 2026-08-20 that deleted 358 QA
 * imageMap entries pointing at the prod bucket, leaving 985/991 products showing
 * PLACEHOLDER_IMAGE. (403 has since been removed from DEAD_STATUSES.)
 *
 * By default only entries whose object actually EXISTS in the target bucket are
 * restored — checked with an authenticated exists() call, not an anonymous probe.
 * So run this AFTER rsyncing the files across; anything not yet copied is skipped
 * rather than restored as a broken link. --skip-existence-check overrides.
 *
 * The environment is an explicit argument. Dry-run unless --apply.
 *
 * Usage:
 *   node scripts/restore-image-map.js qa imageMap-backup-qa-1787230632835.json
 *   node scripts/restore-image-map.js qa imageMap-backup-qa-1787230632835.json --apply
 */
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const API_ROOT = path.resolve(__dirname, '..');

const ENV_FILES = { dev: '.env.local.dev', qa: '.env.local.qa', prod: '.env.local.prod' };
const EXPECTED_PROJECT = { dev: 'suppliable-dev', qa: 'suppliable-qa-723f2', prod: 'suppliable-app' };

const argv = process.argv.slice(2);
const envName = (argv[0] || '').toLowerCase();
const backupArg = argv[1];
const APPLY = argv.includes('--apply');
const SKIP_EXISTENCE = argv.includes('--skip-existence-check');
// Remove placehold.co values already stored in the live map. Storing a placeholder
// is always wrong: productService.buildImage() already substitutes PLACEHOLDER_IMAGE
// when a key is absent, and the stored form (placehold.co/400x300?text=No+Image)
// has no extension so it serves SVG, which the app renders worse than the PNG default.
const DROP_PLACEHOLDERS = argv.includes('--drop-placeholders');

if (!ENV_FILES[envName] || !backupArg) {
  console.error('Usage: node scripts/restore-image-map.js <dev|qa|prod> <backup.json> [--apply] [--skip-existence-check] [--drop-placeholders]');
  process.exit(1);
}

const envPath = path.join(API_ROOT, ENV_FILES[envName]);
if (!fs.existsSync(envPath)) {
  console.error(`Missing env file: ${ENV_FILES[envName]}`);
  process.exit(1);
}
const cfg = dotenv.parse(fs.readFileSync(envPath));

const SA_PATH = cfg.FIREBASE_SERVICE_ACCOUNT;
const TARGET_BUCKET = cfg.FIREBASE_STORAGE_BUCKET;
if (!SA_PATH || !TARGET_BUCKET) {
  console.error(`FIREBASE_SERVICE_ACCOUNT / FIREBASE_STORAGE_BUCKET missing from ${ENV_FILES[envName]}`);
  process.exit(1);
}

const admin = require('firebase-admin');
const serviceAccount = require(path.isAbsolute(SA_PATH) ? SA_PATH : path.join(API_ROOT, SA_PATH));
if (serviceAccount.project_id !== EXPECTED_PROJECT[envName]) {
  console.error(
    `FATAL: ${ENV_FILES[envName]} holds a service account for project_id=${serviceAccount.project_id}, ` +
    `but "${envName}" expects ${EXPECTED_PROJECT[envName]}. Refusing to run.`
  );
  process.exit(1);
}

const SOURCE_BUCKETS = [
  'suppliable-qa-723f2.firebasestorage.app',
  'suppliable-qa-723f2.appspot.com',
  'suppliable-app.firebasestorage.app',
  'suppliable-app.appspot.com',
].filter(b => b !== TARGET_BUCKET);

admin.initializeApp({ credential: admin.credential.cert(serviceAccount), storageBucket: TARGET_BUCKET });
const db = admin.firestore();
const bucket = admin.storage().bucket(TARGET_BUCKET);

const isPlaceholder = url => /(^|\/\/)([a-z0-9-]+\.)?placehold\.co\//.test(String(url));

function retarget(url) {
  let out = String(url);
  for (const src of SOURCE_BUCKETS) {
    if (out.includes(src)) out = out.split(src).join(TARGET_BUCKET);
  }
  return out;
}

const OWN_PREFIX = `https://storage.googleapis.com/${TARGET_BUCKET}/`;
async function existsInTarget(url) {
  if (!url.startsWith(OWN_PREFIX)) return null; // not ours to verify
  const objectPath = decodeURIComponent(url.slice(OWN_PREFIX.length).split('?')[0]);
  try {
    const [ok] = await bucket.file(objectPath).exists();
    return ok;
  } catch {
    return null;
  }
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }));
  return out;
}

(async () => {
  const backupPath = path.isAbsolute(backupArg) ? backupArg : path.join(API_ROOT, backupArg);
  if (!fs.existsSync(backupPath)) {
    console.error(`Backup not found: ${backupPath}`);
    process.exit(1);
  }
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

  const snap = await db.collection('config').doc('imageMap').get();
  const current = snap.exists ? snap.data() : {};

  console.log(`Environment    : ${envName} (${ENV_FILES[envName]})`);
  console.log(`Target bucket  : ${TARGET_BUCKET}`);
  console.log(`Backup         : ${path.basename(backupPath)} (${Object.keys(backup).length} entries)`);
  console.log(`Currently live : ${Object.keys(current).length} entries`);
  console.log(`Mode           : ${APPLY ? 'APPLY (writes will happen)' : 'DRY-RUN (no writes)'}`);
  console.log('');

  // Only consider keys the live map has lost. Never clobber a newer value.
  const missingAll = Object.entries(backup).filter(([k]) => !(k in current));
  const placeholderEntries = missingAll.filter(([, v]) => isPlaceholder(v));
  const missing = missingAll.filter(([, v]) => !isPlaceholder(v));
  console.log(`Missing from live map      : ${missingAll.length}`);
  console.log(`  of which are placeholders: ${placeholderEntries.length} (never restored)`);
  console.log(`  real image refs          : ${missing.length}`);

  const retargeted = missing.map(([k, v]) => [k, retarget(v)]);

  let restorable = retargeted;
  let skipped = [];
  if (!SKIP_EXISTENCE) {
    process.stdout.write('Verifying objects exist in target bucket... ');
    const verdicts = await pool(retargeted, 20, ([, url]) => existsInTarget(url));
    console.log('done');
    restorable = retargeted.filter((_, i) => verdicts[i] !== false);
    skipped = retargeted.filter((_, i) => verdicts[i] === false);
  }

  console.log(`Restorable           : ${restorable.length}`);
  console.log(`Skipped (not in bucket): ${skipped.length}`);
  if (skipped.length) {
    console.log('  → rsync the files across first, then re-run:');
    console.log(`     gsutil -m rsync -r -a public-read gs://<source>/products/ gs://${TARGET_BUCKET}/products/`);
    skipped.slice(0, 3).forEach(([k, u]) => console.log(`     e.g. ${k} → ${u.slice(0, 90)}`));
  }
  console.log('');

  const livePlaceholders = Object.entries(current).filter(([, v]) => isPlaceholder(v)).map(([k]) => k);
  if (DROP_PLACEHOLDERS) {
    console.log(`Placeholder entries in live map to drop: ${livePlaceholders.length}`);
  } else if (livePlaceholders.length) {
    console.log(`Note: live map holds ${livePlaceholders.length} placeholder value(s) — re-run with --drop-placeholders to remove them.`);
  }
  console.log('');

  if (!APPLY) {
    console.log('Dry run — nothing written. Re-run with --apply to restore.');
    return;
  }
  if (!restorable.length && !(DROP_PLACEHOLDERS && livePlaceholders.length)) {
    console.log('Nothing to do.');
    return;
  }

  const preRestore = path.join(API_ROOT, `imageMap-prerestore-${envName}-${Date.now()}.json`);
  fs.writeFileSync(preRestore, JSON.stringify(current, null, 2));
  console.log(`Pre-restore backup written: ${path.basename(preRestore)}`);

  if (restorable.length) {
    await db.collection('config').doc('imageMap').set(Object.fromEntries(restorable), { merge: true });
    console.log(`Restored ${restorable.length} entries into config/imageMap.`);
  }
  if (DROP_PLACEHOLDERS && livePlaceholders.length) {
    const del = admin.firestore.FieldValue.delete();
    await db.collection('config').doc('imageMap')
      .update(Object.fromEntries(livePlaceholders.map(k => [k, del])));
    console.log(`Dropped ${livePlaceholders.length} placeholder entries from config/imageMap.`);
  }
  console.log('Remember to clear the product cache (Redis) so the new map is served.');
})().catch(err => {
  console.error('restore-image-map failed:', err.message);
  process.exit(1);
});
