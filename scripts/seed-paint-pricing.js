'use strict';

const admin = require('firebase-admin');
const serviceAccount = require('../firebase-service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = admin.firestore();

// All 10 tintable product groups created in Zoho.
// group_id is the Firestore document ID in paintPricing collection.
// Prices are GST-inclusive (posService.js back-calculates base via /1.18).
const PRODUCTS = [
  { groupId: '3820623000000222814', productName: 'Asian Paints Tractor Interior Emulsion Paint Colour' },
  { groupId: '3820623000000223090', productName: 'Asian Paints Ace Exterior Emulsion Paint Colour' },
  { groupId: '3820623000000221874', productName: 'Asian Paints Ace Shyne Exterior Emulsion Paint Colour' },
  { groupId: '3820623000000222878', productName: 'Asian Paints Tractor Shyne Interior Emulsion Paint Colour' },
  { groupId: '3820623000000223154', productName: 'Asian Paints Apcolite Premium Interior Emulsion Paint Colour' },
  { groupId: '3820623000000221938', productName: 'Asian Paints Apex Exterior Emulsion Paint Colour' },
  { groupId: '3820623000000222942', productName: 'Asian Paints Apex Ultima Exterior Emulsion Paint Colour' },
  { groupId: '3820623000000223218', productName: 'Asian Paints Apex Ultima Protek Exterior Emulsion Paint Colour' },
  { groupId: '3820623000000224002', productName: 'Asian Paints Royal Luxury Interior Emulsion Paint Colour' },
  { groupId: '3820623000000225006', productName: 'Asian Paints Royal Shyne Luxury Interior Emulsion Paint Colour' },
];

// From Tintable_Products_Template_v2 (1).xlsx — same for all 10 products.
// Prices are inclusive of 18% GST.
const TIERS = {
  light: { '1L': 230, '4L': 800,  '10L': 1700, '20L': 4600 },
  mid:   { '1L': 250, '4L': 830,  '10L': 2000, '20L': 5000 },
  dark:  { '1L': 260, '4L': 850,  '10L': 2200, '20L': 5200 },
};

async function main() {
  const updatedAt = new Date().toISOString();
  let created = 0;
  let skipped = 0;

  for (const { groupId, productName } of PRODUCTS) {
    const ref = db.collection('paintPricing').doc(groupId);
    const snap = await ref.get();

    if (snap.exists) {
      console.log(`· Skip (already exists): ${productName}`);
      skipped++;
      continue;
    }

    await ref.set({
      productName,
      brandSlug: 'asian-paints',
      tiers: TIERS,
      updatedAt,
    });

    console.log(`✓ Created: ${productName} (${groupId})`);
    created++;
  }

  console.log(`\nDone. Created: ${created}, Skipped: ${skipped}`);
  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
