'use strict';

const admin = require('firebase-admin');
const serviceAccount = require('../firebase-service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = admin.firestore();

const SAMPLE_SHADES = [
  { code: '7124', name: 'Sonnet',       tier: 'light', active: true },
  { code: '0520', name: 'Signal Red',   tier: 'dark',  active: true },
  { code: 'L136', name: 'Pebble White', tier: 'light', active: true },
];

async function main() {
  // 1. Create brand doc
  const brandRef = db.collection('shades').doc('asian-paints');
  const brandSnap = await brandRef.get();
  if (!brandSnap.exists) {
    await brandRef.set({
      brandName: 'Asian Paints',
      brandSlug: 'asian-paints',
      createdAt: new Date().toISOString(),
    });
    console.log('✓ Created shades/asian-paints');
  } else {
    console.log('· shades/asian-paints already exists');
  }

  // 2. Create sample shades
  const coloursRef = brandRef.collection('colours');
  for (const shade of SAMPLE_SHADES) {
    const existing = await coloursRef.where('code', '==', shade.code).limit(1).get();
    if (existing.empty) {
      await coloursRef.add({ ...shade, createdAt: new Date().toISOString() });
      console.log(`✓ Created shade ${shade.code} - ${shade.name} (${shade.tier})`);
    } else {
      console.log(`· Shade ${shade.code} - ${shade.name} already exists`);
    }
  }

  console.log('\nDone.');
  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
