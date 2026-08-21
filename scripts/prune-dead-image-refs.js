'use strict';

/**
 * prune-dead-image-refs.js
 *
 * Removes entries from Firestore `config/imageMap` whose image URL no longer
 * resolves, and — where a working alternative exists in Zoho — repoints them
 * instead of deleting.
 *
 * Why: QA's imageMap was overwritten by a prod→QA catalog import and carries
 * absolute prod-bucket URLs whose objects were later deleted from prod. Because
 * productService merges as `{ ...zohoImages, ...firestoreImages }`, the dead
 * Firestore value wins over anything Zoho holds, so those products render as the
 * broken-image icon rather than falling back. Measured 2026-08-20: 354 of QA's
 * 991 rendered products were broken this way; prod measured 0.
 *
 * Deleting a dead key is always at least as good as keeping it — the product
 * falls back to the placeholder instead of a broken image — and where Zoho has a
 * URL that actually resolves, --repoint restores a real image.
 *
 * SAFETY: a key is only ever touched when its URL is *definitively* dead
 * (HTTP 403/404/410, or confirmed absent from this environment's own bucket).
 * Network errors, timeouts, 5xx and 429 are treated as UNKNOWN and left alone —
 * a flaky third-party host must never cause data deletion.
 *
 * `featured_*` keys hold booleans, not URLs, and are never touched.
 *
 * Usage:
 *   cd construction-api
 *   node scripts/prune-dead-image-refs.js qa                      # dry-run
 *   node scripts/prune-dead-image-refs.js qa --apply              # delete dead keys
 *   node scripts/prune-dead-image-refs.js qa --apply --repoint    # + use live Zoho URLs
 *   node scripts/prune-dead-image-refs.js qa --limit 50           # sample first
 *   node scripts/prune-dead-image-refs.js qa --apply --drop-placeholders
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const https = require('https');
const http = require('http');

const API_ROOT = path.resolve(__dirname, '..');

const TARGETS = {
  dev:  { projectId: 'suppliable-dev',      bucket: 'suppliable-dev.firebasestorage.app' },
  qa:   { projectId: 'suppliable-qa-723f2', bucket: 'suppliable-qa-723f2.firebasestorage.app' },
  prod: { projectId: 'suppliable-app',      bucket: 'suppliable-app.firebasestorage.app' },
};

// ── args ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const envName = (argv[0] || '').toLowerCase();
const target = TARGETS[envName];
if (!target) {
  console.error('Usage: node scripts/prune-dead-image-refs.js <dev|qa|prod> [--apply] [--repoint] [--drop-placeholders] [--limit N]');
  process.exit(1);
}
const APPLY = argv.includes('--apply');
const REPOINT = argv.includes('--repoint');
// Storing a placeholder URL in imageMap is redundant — productService.buildImage()
// already substitutes PLACEHOLDER_IMAGE when a product has no entry. Worse, the
// stored form was historically `placehold.co/400x300?text=No+Image`, which serves
// SVG that Flutter cannot decode, so those products showed the error widget
// instead of a placeholder. Dropping the key restores the correct fallback.
const DROP_PLACEHOLDERS = argv.includes('--drop-placeholders');
const limitIdx = argv.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? parseInt(argv[limitIdx + 1], 10) : Infinity;

// ── credential safety, before any app module is loaded ───────────────────────

const envFile = path.join(API_ROOT, `.env.local.${envName}`);
if (!fs.existsSync(envFile)) {
  console.error(`Missing ${envFile}`);
  process.exit(1);
}
const parsed = dotenv.parse(fs.readFileSync(envFile));
const saPath = (parsed.FIREBASE_SERVICE_ACCOUNT || '').trim();
if (!saPath) {
  console.error(`FIREBASE_SERVICE_ACCOUNT not set in .env.local.${envName}`);
  process.exit(1);
}
const sa = require(saPath.startsWith('/') ? saPath : path.resolve(API_ROOT, saPath));
if (sa.project_id !== target.projectId) {
  console.error(`Refusing to run: service account project is ${sa.project_id} — expected ${target.projectId}`);
  process.exit(1);
}

// Pin the dotenv cascade in src/config/env.js to this environment's file before
// requiring anything that reads it — otherwise .env.local (dev) is loaded last
// with override:true and a qa/prod run silently authenticates as dev.
process.env.ENV_FILE = `.env.local.${envName}`;

const admin = require('../src/utils/firebaseAdmin');
const { getZohoProducts } = require('../src/services/zohoService');

const db = admin.firestore();
const bucket = admin.storage().bucket(target.bucket);

// ── liveness probing ─────────────────────────────────────────────────────────

// 403 is deliberately NOT here. Anonymously, a cross-project Storage object
// answers 403 AccessDenied — the object exists, we just cannot read it without
// credentials. Treating that as "dead" deleted 358 QA imageMap entries on
// 2026-08-20 that pointed at the prod bucket. 404/410 mean genuinely absent.
// A 403 is a permissions problem for a human to look at, so it falls through
// to 'unknown', which this script leaves untouched.
const DEAD_STATUSES = new Set([404, 410]);
const livenessCache = new Map(); // url → 'alive' | 'dead' | 'unknown'

function request(url, method) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ status: 'INVALID' }); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + (u.search || ''),
      method,
      // A byte-range GET is enough to prove existence without pulling the file.
      headers: method === 'GET' ? { Range: 'bytes=0-0' } : {},
    }, (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 'TIMEOUT' }); });
    req.on('error', () => resolve({ status: 'ERROR' }));
    req.end();
  });
}

async function probe(url) {
  if (livenessCache.has(url)) return livenessCache.get(url);

  let verdict;
  const ownBucketPrefix = `https://storage.googleapis.com/${target.bucket}/`;

  if (url.startsWith(ownBucketPrefix)) {
    // Authenticated existence check — unambiguous, and distinguishes "absent"
    // from "present but not public", which an anonymous HEAD cannot.
    const objectPath = decodeURIComponent(url.slice(ownBucketPrefix.length).split('?')[0]);
    try {
      const [exists] = await bucket.file(objectPath).exists();
      verdict = exists ? 'alive' : 'dead';
    } catch {
      verdict = 'unknown';
    }
  } else {
    let res = await request(url, 'HEAD');
    // Some CDNs (and Wix in particular) reject HEAD outright. Retry with a
    // range GET before concluding anything, so a 405 is never read as "dead".
    if (typeof res.status !== 'number' || res.status === 405 || res.status === 501) {
      res = await request(url, 'GET');
    }
    if (typeof res.status !== 'number') verdict = 'unknown';
    else if (res.status >= 200 && res.status < 400) verdict = 'alive';
    else if (DEAD_STATUSES.has(res.status)) verdict = 'dead';
    else verdict = 'unknown';
  }

  livenessCache.set(url, verdict);
  return verdict;
}

async function pool(items, concurrency, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Environment : ${envName}`);
  console.log(`Project     : ${sa.project_id}`);
  console.log(`Bucket      : ${target.bucket}`);
  console.log(`Mode        : ${APPLY ? 'APPLY (Firestore will be written)' : 'DRY-RUN (no writes)'}`);
  console.log(`Repoint     : ${REPOINT ? 'yes — dead keys with a live Zoho URL are rewritten' : 'no — dead keys are deleted'}`);
  console.log('');

  const snap = await db.collection('config').doc('imageMap').get();
  if (!snap.exists) {
    console.error('config/imageMap does not exist — nothing to do.');
    process.exit(1);
  }
  const imageMap = snap.data();

  // featured_* keys are booleans; only string URL values are candidates.
  const entries = Object.entries(imageMap)
    .filter(([k, v]) => !k.startsWith('featured_') && typeof v === 'string' && /^https?:\/\//.test(v))
    .slice(0, LIMIT);

  console.log(`imageMap keys total : ${Object.keys(imageMap).length}`);
  console.log(`URL entries to check: ${entries.length}`);

  // Zoho's own image URL, read from BOTH shapes. The list endpoint returns it as
  // a raw `cf_image_url` field and leaves custom_field_hash empty, which is why
  // productService's hash-only read yields nothing — see the note printed at the
  // end. Reading both here mirrors the dual-read used for cf_rack_number/cf_walkin.
  let zohoAlt = {};
  try {
    const items = await getZohoProducts(null);
    items.forEach((i) => {
      const u = i.cf_image_url || i.custom_field_hash?.cf_image_url;
      if (u) zohoAlt[i.item_id] = u;
    });
    console.log(`Zoho items with cf_image_url: ${Object.keys(zohoAlt).length}`);
  } catch (e) {
    console.log(`Zoho lookup failed (${e.message}) — proceeding without alternatives.`);
  }
  console.log('');

  process.stdout.write('Probing current URLs... ');
  const verdicts = await pool(entries, 20, ([, url]) => probe(url));
  console.log('done');

  const isPlaceholder = ([, url]) => /(^|\/\/)([a-z0-9-]+\.)?placehold\.co\//.test(url);
  const placeholders = DROP_PLACEHOLDERS ? entries.filter(isPlaceholder) : [];
  const placeholderKeys = new Set(placeholders.map(([k]) => k));

  const dead = entries.filter((_, i) => verdicts[i] === 'dead' && !placeholderKeys.has(entries[i][0]));
  const alive = entries.filter((_, i) => verdicts[i] === 'alive');
  const unknown = entries.filter((_, i) => verdicts[i] === 'unknown');

  // Only probe alternatives for keys we would otherwise delete.
  const altCandidates = dead.filter(([k]) => zohoAlt[k] && zohoAlt[k] !== imageMap[k]);
  let repointable = [];
  if (altCandidates.length) {
    process.stdout.write(`Probing ${altCandidates.length} Zoho alternative(s)... `);
    const altVerdicts = await pool(altCandidates, 20, ([k]) => probe(zohoAlt[k]));
    repointable = altCandidates.filter((_, i) => altVerdicts[i] === 'alive');
    console.log('done');
  }
  const repointSet = new Set(repointable.map(([k]) => k));
  const toDelete = [
    ...dead.filter(([k]) => !(REPOINT && repointSet.has(k))),
    ...placeholders,
  ];

  console.log('');
  const row = (l, v) => console.log(`${l.padEnd(34)}: ${v}`);
  row('Alive (kept)', alive.length);
  row('Unknown — left alone', unknown.length);
  row('Dead', dead.length);
  if (DROP_PLACEHOLDERS) row('Redundant placeholder entries', placeholders.length);
  if (repointable.length) {
    row('  ...with a LIVE Zoho alternative', repointable.length);
    if (!REPOINT) console.log('     (pass --repoint to restore these instead of deleting them)');
  }
  if (REPOINT && repointable.length) row(APPLY ? 'Repointing' : 'Would repoint', repointable.length);
  row(APPLY ? 'Deleting' : 'Would delete', toDelete.length);
  console.log('');

  if (toDelete.length) {
    console.log('Sample of keys to delete:');
    toDelete.slice(0, 5).forEach(([k, v]) => console.log(`   ${k}  →  ${v.slice(0, 78)}`));
    console.log('');
  }
  if (repointable.length && REPOINT) {
    console.log('Sample of keys to repoint:');
    repointable.slice(0, 5).forEach(([k]) => console.log(`   ${k}  →  ${zohoAlt[k].slice(0, 70)}`));
    console.log('');
  }

  if (!APPLY) {
    console.log('Re-run with --apply to commit.');
    if (repointable.length && !REPOINT) {
      console.log(`Add --repoint to recover ${repointable.length} image(s) from Zoho instead of deleting them.`);
    }
    if (!DROP_PLACEHOLDERS) {
      const n = entries.filter(isPlaceholder).length;
      if (n) console.log(`Add --drop-placeholders to also remove ${n} redundant placehold.co entr(ies).`);
    }
    process.exit(0);
  }

  if (!toDelete.length && !(REPOINT && repointable.length)) {
    console.log('Nothing to write.');
    process.exit(0);
  }

  // Back up the whole document before mutating it — it is the single source of
  // truth for every product image, and this is a destructive edit.
  const backupPath = path.join(API_ROOT, `imageMap-backup-${envName}-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(imageMap, null, 2));
  console.log(`Backup written: ${backupPath}`);

  // update() with FieldValue.delete() removes keys without rewriting the rest of
  // the document, so concurrent admin edits to other keys survive.
  const update = {};
  for (const [k] of toDelete) update[k] = admin.firestore.FieldValue.delete();
  if (REPOINT) for (const [k] of repointable) update[k] = zohoAlt[k];

  const keys = Object.keys(update);
  for (let i = 0; i < keys.length; i += 400) {
    const chunk = {};
    for (const k of keys.slice(i, i + 400)) chunk[k] = update[k];
    await db.collection('config').doc('imageMap').update(chunk);
  }

  console.log(`\nWrote ${keys.length} change(s) to config/imageMap.`);
  console.log(`Deleted: ${toDelete.length}${REPOINT ? `, repointed: ${repointable.length}` : ''}`);
  console.log('\nThe API caches the catalogue for ~10 min (in-memory + Redis),');
  console.log('so the app reflects this after that TTL expires.');

  if (unknown.length) {
    console.log(`\n${unknown.length} URL(s) could not be verified and were left untouched.`);
    console.log('Re-run later to re-probe them.');
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
