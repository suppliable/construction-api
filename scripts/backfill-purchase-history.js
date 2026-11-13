'use strict';

// One-off backfill of itemPurchaseHistory from every Zoho bill.
//
// The scheduled sync only fetches bills modified since its watermark, so the
// first run needs a full walk: ~241 bills, one detail call each, deliberately
// serial because Zoho rate-limits. Expect a couple of minutes.
//
//   node scripts/backfill-purchase-history.js
//
// Safe to re-run: every write is an idempotent upsert keyed by item id.

require('dotenv').config();

(async () => {
  const { syncFromBills } = require('../src/services/purchaseHistoryService');
  const started = Date.now();
  console.log('[backfill] walking every Zoho bill — this is the slow one, ~1 call per bill');
  try {
    const result = await syncFromBills({ full: true });
    console.log('[backfill] done in', Math.round((Date.now() - started) / 1000) + 's');
    console.log('[backfill]', JSON.stringify(result));
    process.exit(0);
  } catch (err) {
    console.error('[backfill] FAILED:', err.response?.data?.message || err.message);
    process.exit(1);
  }
})();
