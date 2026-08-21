'use strict';

/**
 * optimize-existing-images.js
 *
 * Re-encodes images already sitting in a Storage bucket to WebP at the same
 * per-folder width caps that new uploads now get (src/services/imageOptimizer.js),
 * then repoints every Firestore reference at the new object.
 *
 * Why: the resize on the upload path only helps images uploaded from now on.
 * Prod is carrying ~280 MB of raw PNGs — 1.3 MB category tiles rendered at
 * 52x52dp, 1.4 MB banners, 485 KB grid thumbnails — that predate it.
 *
 * Each optimized image is written to a NEW content-unique path rather than
 * overwritten in place. Objects are stored with `Cache-Control: immutable`, so
 * a given URL must never change meaning: clients and CDNs that already cached
 * the old bytes are entitled to keep them forever. A new path guarantees every
 * client picks up the smaller file. The originals are left in the bucket and
 * reported at the end as orphans — deleting them is a separate, deliberate step.
 *
 * Zoho is deliberately NOT updated. productService merges the Zoho image map
 * with the Firestore one as `{ ...zoho, ...firestore }`, so the Firestore value
 * wins for any item this script touches. See the caveat printed at the end.
 *
 * IMPORTANT: does NOT use src/config/env.js. That runs a dotenv cascade where
 * .env.local is loaded last with override:true, forcing credentials back to dev
 * — so a prod run would silently authenticate as dev. This parses the target
 * .env.local.<env> by hand and asserts the service-account project matches
 * before touching anything, same as scripts/clear-rtdb-liveorders.js.
 *
 * Usage:
 *   cd construction-api
 *   node scripts/optimize-existing-images.js dev            # dry-run
 *   node scripts/optimize-existing-images.js dev --apply    # actually write
 *   node scripts/optimize-existing-images.js prod --prefix categories/
 *   node scripts/optimize-existing-images.js qa --limit 20  # sample first
 *   node scripts/optimize-existing-images.js qa --all      # incl. unreferenced objects
 *
 * The dry run does the full re-encode in memory and reports the real byte
 * savings per object — it just never writes to Storage or Firestore.
 */

const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const dotenv = require('dotenv');
const { optimizeImage, extensionFor } = require('../src/services/imageOptimizer');

const API_ROOT = path.resolve(__dirname, '..');

const TARGETS = {
  dev:  { projectId: 'suppliable-dev',       bucket: 'suppliable-dev.firebasestorage.app' },
  qa:   { projectId: 'suppliable-qa-723f2',  bucket: 'suppliable-qa-723f2.firebasestorage.app' },
  prod: { projectId: 'suppliable-app',       bucket: 'suppliable-app.firebasestorage.app' },
};

// Folders holding catalogue imagery. `deliveries/` (proof-of-delivery photos)
// and `pos-quotations/` (PDFs) are excluded by default — POD photos are order
// evidence and are small already; pass --prefix deliveries/ to include them.
const DEFAULT_PREFIXES = ['products/', 'categories/', 'banners/'];

// Every collection that can hold an image URL. Matched by value, not field name,
// because callers write inconsistent keys (imageUrl / image_url / deliveryPhotoUrl)
// — the same approach scripts/rewrite-image-urls.js already uses.
const COLLECTIONS = ['config', 'categories', 'banners', 'products'];

const CACHE_CONTROL = 'public, max-age=31536000, immutable';

// ── args ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const envName = (argv[0] || '').toLowerCase();
const target = TARGETS[envName];
if (!target) {
  console.error('Usage: node scripts/optimize-existing-images.js <dev|qa|prod> [--apply] [--prefix products/] [--limit N] [--all]');
  process.exit(1);
}

const APPLY = argv.includes('--apply');
// --all processes every object in the bucket, not just those Firestore references.
const ALL = argv.includes('--all');
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
};
const PREFIXES = flagValue('--prefix') ? [flagValue('--prefix')] : DEFAULT_PREFIXES;
const LIMIT = flagValue('--limit') ? parseInt(flagValue('--limit'), 10) : Infinity;

// ── env + credential safety ──────────────────────────────────────────────────

const envFile = path.join(API_ROOT, `.env.local.${envName}`);
if (!fs.existsSync(envFile)) {
  console.error(`Missing ${envFile}`);
  process.exit(1);
}
const parsed = dotenv.parse(fs.readFileSync(envFile));
const saPath = (parsed.FIREBASE_SERVICE_ACCOUNT || '').trim();
const bucketName = (parsed.FIREBASE_STORAGE_BUCKET || '').trim() || target.bucket;

if (!saPath) {
  console.error(`FIREBASE_SERVICE_ACCOUNT not set in .env.local.${envName}`);
  process.exit(1);
}
if (bucketName !== target.bucket) {
  console.error(`Refusing to run: ${envName} FIREBASE_STORAGE_BUCKET is ${bucketName} — expected ${target.bucket}`);
  process.exit(1);
}
const sa = require(saPath.startsWith('/') ? saPath : path.resolve(API_ROOT, saPath));
if (sa.project_id !== target.projectId) {
  console.error(`Refusing to run: service account project is ${sa.project_id} — expected ${target.projectId}`);
  process.exit(1);
}

const app = admin.initializeApp({
  credential: admin.credential.cert(sa),
  storageBucket: bucketName,
}, `${envName}-image-optimize`);

const bucket = app.storage().bucket();
const db = app.firestore();

// ── helpers ──────────────────────────────────────────────────────────────────

const publicUrl = (objectPath) => `https://storage.googleapis.com/${bucketName}/${objectPath}`;

const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

function newPathFor(objectPath, mimeType) {
  const folder = objectPath.split('/')[0];
  return `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${extensionFor(mimeType)}`;
}

// Recursive value rewrite over a Firestore document, matching by URL value.
function rewriteFields(obj, urlMap) {
  let changed = false;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') {
      const inner = rewriteFields(v, urlMap);
      out[k] = inner.value;
      if (inner.changed) changed = true;
    } else if (typeof v === 'string' && urlMap.has(v)) {
      out[k] = urlMap.get(v);
      changed = true;
    } else {
      out[k] = v;
    }
  }
  return { value: out, changed };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Environment : ${envName}`);
  console.log(`Project     : ${sa.project_id}`);
  console.log(`Bucket      : ${bucketName}`);
  console.log(`Prefixes    : ${PREFIXES.join(', ')}`);
  if (LIMIT !== Infinity) console.log(`Limit       : ${LIMIT} object(s)`);
  console.log(`Mode        : ${APPLY ? 'APPLY (Storage + Firestore will be written)' : 'DRY-RUN (no writes)'}`);
  console.log('');

  const files = [];
  for (const prefix of PREFIXES) {
    const [batch] = await bucket.getFiles({ prefix });
    files.push(...batch);
  }

  // Only process objects Firestore actually points at. Superseded originals from
  // a previous run are still in the bucket (this script never deletes), and
  // without this filter a second run would re-optimize each of them into another
  // new object that nothing references — accumulating junk on every re-run.
  // Restricting to referenced objects also skips images no longer used at all.
  let referenced = null;
  if (!ALL) {
    referenced = new Set();
    for (const col of COLLECTIONS) {
      let snap;
      try { snap = await db.collection(col).get(); } catch { continue; }
      const walk = (o) => {
        for (const v of Object.values(o)) {
          if (v && typeof v === 'object') walk(v);
          else if (typeof v === 'string' && v.startsWith(`https://storage.googleapis.com/${bucketName}/`)) {
            referenced.add(decodeURIComponent(v.slice(`https://storage.googleapis.com/${bucketName}/`.length).split('?')[0]));
          }
        }
      };
      snap.docs.forEach(d => walk(d.data()));
    }
  }

  const all = files.filter(f => !f.name.endsWith('/'));
  const inScope = referenced ? all.filter(f => referenced.has(f.name)) : all;
  const candidates = inScope.slice(0, LIMIT);

  if (referenced) {
    console.log(`Objects in bucket   : ${all.length}`);
    console.log(`Referenced in Firestore: ${inScope.length}  (${all.length - inScope.length} unreferenced, skipped — use --all to include)`);
    console.log('');
  }

  const urlMap = new Map();   // old public URL → new public URL
  const orphans = [];         // object paths superseded by a smaller copy
  let bytesBefore = 0;
  let bytesAfter = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of candidates) {
    const contentType = (file.metadata && file.metadata.contentType) || '';
    const folder = file.name.split('/')[0];

    let buffer;
    try {
      [buffer] = await file.download();
    } catch (e) {
      failed++;
      console.error(`  FAILED download ${file.name}: ${e.message}`);
      continue;
    }

    const result = await optimizeImage(buffer, contentType, folder);
    if (!result.optimized) {
      skipped++;
      if (result.reason !== 'no-gain') {
        console.log(`  skip  ${file.name}  (${result.reason})`);
      }
      continue;
    }

    const saved = result.bytesBefore - result.bytesAfter;
    const pct = ((saved / result.bytesBefore) * 100).toFixed(0);
    bytesBefore += result.bytesBefore;
    bytesAfter += result.bytesAfter;

    const destPath = newPathFor(file.name, result.mimeType);
    console.log(`  ${APPLY ? 'write' : 'would'} ${file.name}`);
    console.log(`         ${kb(result.bytesBefore)} → ${kb(result.bytesAfter)}  (-${pct}%, ${result.width}px wide)`);

    if (APPLY) {
      try {
        await bucket.file(destPath).save(result.buffer, {
          contentType: result.mimeType,
          predefinedAcl: 'publicRead',
          metadata: { cacheControl: CACHE_CONTROL },
          resumable: false,
        });
      } catch (e) {
        failed++;
        console.error(`  FAILED upload ${destPath}: ${e.message}`);
        continue;
      }
    }

    urlMap.set(publicUrl(file.name), publicUrl(destPath));
    orphans.push(file.name);

    // Timestamp-based filenames collide if two objects are processed inside the
    // same millisecond; the random suffix makes that vanishingly unlikely, but
    // yielding also keeps a large prod run from monopolising the event loop.
    await new Promise(r => setImmediate(r));
  }

  // ── repoint Firestore references ──────────────────────────────────────────

  console.log('');
  let docsChanged = 0;
  if (urlMap.size > 0) {
    for (const col of COLLECTIONS) {
      let snap;
      try {
        snap = await db.collection(col).get();
      } catch (e) {
        console.error(`  FAILED reading collection ${col}: ${e.message}`);
        failed++;
        continue;
      }
      const updates = [];
      for (const doc of snap.docs) {
        const r = rewriteFields(doc.data(), urlMap);
        if (r.changed) updates.push({ ref: doc.ref, after: r.value });
      }
      if (updates.length === 0) continue;
      console.log(`[${col}] ${APPLY ? 'updating' : 'would update'} ${updates.length} doc(s): ${updates.map(u => u.ref.id).join(', ')}`);
      docsChanged += updates.length;
      if (APPLY) {
        // Firestore caps a batch at 500 writes.
        for (let i = 0; i < updates.length; i += 400) {
          const batch = db.batch();
          // merge:true, not a wholesale replace. config/imageMap holds every
          // product's image URL plus the featured_* flags; this script only ever
          // rewrites existing values and never needs to delete a key, so merging
          // avoids clobbering anything an admin adds while the run is in flight.
          for (const u of updates.slice(i, i + 400)) batch.set(u.ref, u.after, { merge: true });
          await batch.commit();
        }
      }
    }
  }

  // ── summary ───────────────────────────────────────────────────────────────

  const saved = bytesBefore - bytesAfter;
  console.log('');
  console.log('─'.repeat(60));
  const row = (label, value) => console.log(`${label.padEnd(21)}: ${value}`);
  row('Objects processed', candidates.length);
  row(APPLY ? 'Optimized' : 'Would optimize', urlMap.size);
  row('Skipped (no gain etc)', skipped);
  row(APPLY ? 'Firestore docs written' : 'Firestore docs', docsChanged);
  if (urlMap.size > 0) {
    row('Size', `${mb(bytesBefore)} → ${mb(bytesAfter)}`);
    row('Saved', `${mb(saved)} (${((saved / bytesBefore) * 100).toFixed(0)}%)`);
  }
  if (failed) row('Failed', failed);

  if (!APPLY && urlMap.size > 0) {
    console.log('\nRe-run with --apply to commit.');
  }

  if (APPLY && orphans.length > 0) {
    const orphanFile = path.join(API_ROOT, `orphaned-images-${envName}-${Date.now()}.txt`);
    fs.writeFileSync(orphanFile, orphans.join('\n') + '\n');
    console.log(`\n${orphans.length} original object(s) superseded but NOT deleted.`);
    console.log(`Listed in: ${orphanFile}`);
    console.log('Delete them only after confirming the app renders correctly.');
    console.log('\nCAVEAT: Zoho cf_image_url still holds the old URLs. Firestore');
    console.log('config/imageMap takes precedence in productService, so the app is');
    console.log('correct — but do not delete the originals if you may ever clear');
    console.log('the Firestore image map.');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
