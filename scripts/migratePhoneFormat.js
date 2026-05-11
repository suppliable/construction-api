'use strict';

/**
 * One-time migration: convert all Firestore phone fields from "91XXXXXXXXXX"
 * to the canonical E.164 format "+91XXXXXXXXXX".
 *
 * Run BEFORE deploying the normalizePhone() change:
 *   node scripts/migratePhoneFormat.js
 *
 * Safe to run multiple times — documents already in +91 format are skipped.
 */

// Bootstrap only what the script needs — bypass full app env validation
// so this can run without Zoho/JWT/admin credentials in the environment.
const path = require('path');
require('dotenv').config();
require('dotenv').config({ path: path.resolve(__dirname, '../.env.local'), override: true });

const admin = require('firebase-admin');

if (!admin.apps.length) {
  const val = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!val) {
    console.error('FIREBASE_SERVICE_ACCOUNT env var is required');
    process.exit(1);
  }
  let serviceAccount;
  if (val.startsWith('/') || val.startsWith('.')) {
    serviceAccount = require(val);
  } else {
    serviceAccount = JSON.parse(val);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = admin.firestore();

function toE164(phone) {
  if (!phone || phone.startsWith('+')) return null; // already correct or empty
  if (phone.length === 12 && phone.startsWith('91')) return '+' + phone;
  if (phone.length === 10 && /^[6-9]/.test(phone)) return '+91' + phone;
  return null; // unrecognized — skip
}

async function migrateCollection(collectionName, idField) {
  console.log(`\nMigrating ${collectionName}...`);
  const snapshot = await db.collection(collectionName).get();
  let updated = 0, skipped = 0, failed = 0;

  const batch = [];
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const e164 = toE164(data.phone);
    if (!e164) {
      skipped++;
      continue;
    }
    batch.push({ ref: doc.ref, phone: e164, id: data[idField] || doc.id });
  }

  // Firestore batches are limited to 500 ops
  const BATCH_SIZE = 400;
  for (let i = 0; i < batch.length; i += BATCH_SIZE) {
    const chunk = batch.slice(i, i + BATCH_SIZE);
    const writeBatch = db.batch();
    for (const item of chunk) {
      writeBatch.update(item.ref, { phone: item.phone });
    }
    await writeBatch.commit();
    for (const item of chunk) {
      console.log(`  updated ${collectionName}/${item.id}: ${item.phone}`);
      updated++;
    }
  }

  console.log(`  done — updated: ${updated}, skipped (already +91 or unrecognized): ${skipped}, failed: ${failed}`);
  return { updated, skipped, failed };
}

async function main() {
  console.log('Phone format migration: 91XXXXXXXXXX → +91XXXXXXXXXX');
  console.log('='.repeat(55));

  try {
    const customers = await migrateCollection('customers', 'userId');
    const drivers = await migrateCollection('drivers', 'driverId');

    console.log('\nSummary:');
    console.log(`  customers — updated: ${customers.updated}, skipped: ${customers.skipped}`);
    console.log(`  drivers   — updated: ${drivers.updated}, skipped: ${drivers.skipped}`);
    console.log('\nMigration complete.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

main();
