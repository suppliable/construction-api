'use strict';

const admin = require('firebase-admin');
require('dotenv').config();

const shades = require('./asian-paints-shades.json');

async function main() {
  const db = admin.firestore();
  const brandSlug = 'asian-paints';

  await db.collection('shades').doc(brandSlug).set({
    brandName: 'Asian Paints',
    brandSlug,
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  const colRef = db.collection('shades').doc(brandSlug).collection('colours');

  // Check existing codes to avoid duplicates
  const existing = await colRef.get();
  const existingCodes = new Set(existing.docs.map(d => d.data().code));
  console.log(`Existing shades: ${existingCodes.size}`);

  const toImport = shades.filter(s => !existingCodes.has(s.code));
  console.log(`Shades to import: ${toImport.length} (${shades.length - toImport.length} already exist)`);

  const BATCH_SIZE = 400;
  let imported = 0;

  for (let i = 0; i < toImport.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = toImport.slice(i, i + BATCH_SIZE);
    chunk.forEach(shade => {
      const ref = colRef.doc();
      batch.set(ref, {
        code: shade.code,
        name: shade.name,
        hex: shade.hex || null,
        tier: shade.tier,
        active: true,
        createdAt: new Date().toISOString(),
      });
    });
    await batch.commit();
    imported += chunk.length;
    console.log(`Imported ${imported}/${toImport.length}`);
  }

  console.log(`Done. Total in Firestore: ${existingCodes.size + imported}`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
