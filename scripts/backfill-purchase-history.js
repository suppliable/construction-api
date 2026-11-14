'use strict';

// One-off backfill of itemPurchaseHistory from every Zoho bill.
//
//   node scripts/backfill-purchase-history.js --dry-run   # read-only, writes nothing
//   node scripts/backfill-purchase-history.js             # for real
//
// The scheduled sync only fetches bills modified since its watermark, so the
// first run needs a full walk: ~241 bills, one detail call each, deliberately
// serial because Zoho rate-limits. Expect a couple of minutes.
//
// Safe to re-run: every write is an idempotent upsert keyed by item id.

require('dotenv').config();

// config/env.js validates the WHOLE environment at require-time and exits on
// anything missing — including variables this script never touches. A developer
// .env without, say, MSG91_AUTH_KEY would abort the backfill for no reason, so
// fill the gaps with placeholders. Assigned with ??= so a real value always
// wins, and deliberately NOT covering Zoho or Firebase: those must be real or
// the script has nothing to do.
process.env.ADMIN_TOKEN ??= 'backfill-placeholder-token-0000';
process.env.ADMIN_PASSWORD ??= 'backfill-placeholder';
process.env.JWT_SECRET ??= 'backfill-placeholder';
process.env.MSG91_AUTH_KEY ??= 'backfill-placeholder';
process.env.MSG91_TEMPLATE_ID ??= '0123456789abcdef01234567';

const dryRun = process.argv.includes('--dry-run');

(async () => {
  // Required after the placeholders above, so env validation sees them.
  const env = require('../src/config/env');
  const { syncFromBills } = require('../src/services/purchaseHistoryService');

  // This writes to whichever Firebase project the credential points at. Say so
  // loudly — the difference between dev and prod is one env var.
  console.log('[backfill] target project :', env.firebaseProjectId, `(app_env=${env.appEnv})`);
  console.log('[backfill] zoho org       :', process.env.ZOHO_ORG_ID);
  console.log('[backfill] mode           :', dryRun ? 'DRY RUN — nothing will be written' : 'WRITING');
  console.log('[backfill] walking every Zoho bill — this is the slow one, ~1 call per bill');

  const started = Date.now();
  try {
    const result = await syncFromBills({ full: true, dryRun });
    const secs = Math.round((Date.now() - started) / 1000);
    console.log(`[backfill] done in ${secs}s`);
    console.log('[backfill]', JSON.stringify(result));
    if (dryRun) console.log('[backfill] DRY RUN — re-run without --dry-run to persist');
    process.exit(0);
  } catch (err) {
    console.error('[backfill] FAILED:', err.response?.data?.message || err.message);
    process.exit(1);
  }
})();
