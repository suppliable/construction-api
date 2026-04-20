const BASE = 'https://construction-api-2.onrender.com';

// Single generic construction image for all products
const DEFAULT_IMAGE = 'https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=400&q=80';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const fetch = (...args) => import('node-fetch').then(({default:f})=>f(...args));

  const res = await fetch(`${BASE}/api/products`);
  const data = await res.json();
  const products = data.data || [];
  console.log(`Total products: ${products.length}`);

  let updated = 0, skipped = 0, failed = 0;

  for (const product of products) {
    // Skip if already has a real Cloudinary image
    if (product.imageUrl && product.imageUrl.includes('cloudinary')) {
      skipped++;
      continue;
    }

    try {
      const r = await fetch(`${BASE}/api/products/${product.id}/image`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl: DEFAULT_IMAGE })
      });
      const d = await r.json();
      if (d.success) {
        console.log(`✅ ${product.name}`);
        updated++;
      } else {
        console.log(`❌ ${product.name} → ${JSON.stringify(d)}`);
        failed++;
      }
    } catch(e) {
      console.log(`❌ ${product.name} → ${e.message}`);
      failed++;
    }
    await sleep(200);
  }

  console.log(`\nDone: ${updated} updated | ${skipped} skipped | ${failed} failed`);

  // Clear cache
  await fetch(`${BASE}/api/products/cache/clear`, { method: 'POST' });
  console.log('Cache cleared ✅');
})();
