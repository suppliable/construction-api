'use strict';
// Clear the liveOrders node in a Suppliable RTDB (dev or qa).
//   Usage: node scripts/clear-rtdb-liveorders.js dev
//          node scripts/clear-rtdb-liveorders.js qa
//
// IMPORTANT: does NOT use src/config/env.js or src/utils/firebaseAdmin.js.
// Those run a dotenv cascade where .env.local is loaded LAST with override:true
// and forces FIREBASE_SERVICE_ACCOUNT / FIREBASE_DATABASE_URL / EXPECTED_PROJECT_ID
// back to dev — so a qa run would silently authenticate as dev. We parse the
// target .env.local.<env> by hand and init a dedicated admin app, then assert
// the service-account project_id matches before touching anything.
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const dotenv = require('dotenv');

const API_ROOT = path.resolve(__dirname, '..');

const TARGETS = {
  dev: { projectId: 'suppliable-dev', rtdbHost: 'suppliable-dev-default-rtdb' },
  qa:  { projectId: 'suppliable-qa-723f2', rtdbHost: 'suppliable-qa-723f2-default-rtdb' },
};

const envName = (process.argv[2] || '').toLowerCase();
const target = TARGETS[envName];
if (!target) {
  console.error('Usage: node scripts/clear-rtdb-liveorders.js <dev|qa>');
  process.exit(1);
}

const envFile = path.join(API_ROOT, `.env.local.${envName}`);
const parsed = dotenv.parse(fs.readFileSync(envFile));
const dbUrl = (parsed.FIREBASE_DATABASE_URL || '').trim();
const saPath = (parsed.FIREBASE_SERVICE_ACCOUNT || '').trim();

if (!dbUrl.includes(target.rtdbHost)) {
  console.error(`Refusing to run: ${envName} FIREBASE_DATABASE_URL unexpected:`, dbUrl);
  process.exit(1);
}
const sa = require(saPath.startsWith('/') ? saPath : path.resolve(API_ROOT, saPath));
if (sa.project_id !== target.projectId) {
  console.error(`Refusing to run: service account project is ${sa.project_id} — expected ${target.projectId}`);
  process.exit(1);
}

const app = admin.initializeApp({
  credential: admin.credential.cert(sa),
  databaseURL: dbUrl,
}, `${envName}-cleanup`);

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
  console.log(`Done. ${envName} liveOrders cleared.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
