'use strict';
/**
 * revert-imagemap.js
 *
 * Fully reverts config/imageMap to an exact prior snapshot (as written by
 * restore-image-map.js's pre-restore backups, this script's own safety backups,
 * or any imageMap-backup-*.json). Use this to undo a risky imageMap-touching
 * operation — e.g. optimize-existing-images.js --apply — if it goes wrong.
 *
 * Unlike restore-image-map.js (which merges specific missing keys back in),
 * this does a full .set() to the snapshot's exact content: any key added since
 * the snapshot was taken is removed, any key changed is reverted, nothing is
 * merged. Before overwriting, it writes its own snapshot of the CURRENT state
 * so the revert itself is reversible.
 *
 * The environment is an explicit argument. Dry-run unless --apply.
 *
 * Usage:
 *   node scripts/revert-imagemap.js qa imageMap-backup-qa-1787324939476.json
 *   node scripts/revert-imagemap.js qa imageMap-backup-qa-1787324939476.json --apply
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

if (!ENV_FILES[envName] || !backupArg) {
  console.error('Usage: node scripts/revert-imagemap.js <dev|qa|prod> <backup.json> [--apply]');
  process.exit(1);
}

const envPath = path.join(API_ROOT, ENV_FILES[envName]);
if (!fs.existsSync(envPath)) {
  console.error(`Missing env file: ${ENV_FILES[envName]}`);
  process.exit(1);
}
const cfg = dotenv.parse(fs.readFileSync(envPath));

const SA_PATH = cfg.FIREBASE_SERVICE_ACCOUNT;
if (!SA_PATH) {
  console.error(`FIREBASE_SERVICE_ACCOUNT missing from ${ENV_FILES[envName]}`);
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

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

(async () => {
  const backupPath = path.isAbsolute(backupArg) ? backupArg : path.join(API_ROOT, backupArg);
  if (!fs.existsSync(backupPath)) {
    console.error(`Backup not found: ${backupPath}`);
    process.exit(1);
  }
  const snapshot = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

  const liveDoc = await db.collection('config').doc('imageMap').get();
  const current = liveDoc.exists ? liveDoc.data() : {};

  const currentKeys = new Set(Object.keys(current));
  const snapshotKeys = new Set(Object.keys(snapshot));
  const wouldAdd = [...snapshotKeys].filter(k => !currentKeys.has(k) || current[k] !== snapshot[k]);
  const wouldRemove = [...currentKeys].filter(k => !snapshotKeys.has(k));

  console.log(`Environment : ${envName} (${ENV_FILES[envName]})`);
  console.log(`Snapshot    : ${path.basename(backupPath)} (${snapshotKeys.size} entries)`);
  console.log(`Currently live: ${currentKeys.size} entries`);
  console.log(`Mode        : ${APPLY ? 'APPLY (writes will happen)' : 'DRY-RUN (no writes)'}`);
  console.log('');
  console.log(`Would set/change : ${wouldAdd.length}`);
  console.log(`Would remove     : ${wouldRemove.length} (keys present now but absent from the snapshot)`);
  if (wouldRemove.length) {
    wouldRemove.slice(0, 5).forEach(k => console.log(`  - ${k} -> ${current[k]}`));
  }
  console.log('');

  if (!APPLY) {
    console.log('Dry run — nothing written. Re-run with --apply to revert.');
    return;
  }

  const preRevert = path.join(API_ROOT, `imageMap-backup-${envName}-${Date.now()}.json`);
  fs.writeFileSync(preRevert, JSON.stringify(current, null, 2));
  console.log(`Pre-revert backup written: ${path.basename(preRevert)} (so this revert is itself reversible)`);

  // Full overwrite, not merge — anything not in the snapshot is dropped.
  await db.collection('config').doc('imageMap').set(snapshot);
  console.log(`Reverted config/imageMap to the exact contents of ${path.basename(backupPath)}.`);
  console.log('Remember to clear the product cache (POST /api/v1/admin/cache/invalidate-zoho) so the reverted map is served.');
})().catch(err => {
  console.error('revert-imagemap failed:', err.message);
  process.exit(1);
});
