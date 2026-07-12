'use strict';
// One-off: clear the liveOrders node in the suppliable-qa RTDB.
// IMPORTANT: does NOT use src/config/env.js or src/utils/firebaseAdmin.js —
// those run a dotenv cascade where .env.local overrides everything back to dev.
// We read .env.local.qa explicitly and init a dedicated admin app for QA.
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const API_ROOT = path.resolve(__dirname, '..');

// Parse .env.local.qa by hand so nothing else can override it.
const dotenv = require('dotenv');
const qaEnv = dotenv.parse(fs.readFileSync(path.join(API_ROOT, '.env.local.qa')));

const dbUrl = (qaEnv.FIREBASE_DATABASE_URL || '').trim();
const saPath = (qaEnv.FIREBASE_SERVICE_ACCOUNT || '').trim();

if (!dbUrl.includes('suppliable-qa-723f2-default-rtdb')) {
  console.error('Refusing to run: QA FIREBASE_DATABASE_URL unexpected:', dbUrl);
  process.exit(1);
}
const sa = require(saPath.startsWith('/') ? saPath : path.resolve(API_ROOT, saPath));
if (sa.project_id !== 'suppliable-qa-723f2') {
  console.error('Refusing to run: service account project is', sa.project_id, '— expected suppliable-qa-723f2');
  process.exit(1);
}

const app = admin.initializeApp({
  credential: admin.credential.cert(sa),
  databaseURL: dbUrl,
}, 'qa-cleanup');

(async () => {
  const db = app.database();
  console.log('Authenticated as project:', sa.project_id);
  console.log('Target DB :', dbUrl);

  const before = await db.ref('liveOrders').once('value');
  const data = before.val();
  const keys = data ? Object.keys(data) : [];
  console.log('liveOrders records before:', keys.length);
  if (keys.length) console.log('IDs:', keys.join(', '));

  await db.ref('liveOrders').remove();

  const after = await db.ref('liveOrders').once('value');
  console.log('liveOrders value after:', after.val());
  console.log('Done. QA liveOrders cleared.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
