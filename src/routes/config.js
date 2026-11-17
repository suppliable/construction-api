const express = require('express');
const router = express.Router();
const { getCodThreshold, updateCodThreshold, getWarehouseStatus, updateWarehouseStatus, warehouseScheduleTick, pendingOrdersTick, bulkQuoteExpiryTick, purchaseHistoryTick } = require('../controllers/configController');
const { requireScheduler } = require('../middleware/schedulerAuth');
const { cacheFor } = require('../cache/middleware');
const { invalidateConfig } = require('../cache/invalidate');
const { CACHE_TTL_CONFIG_S } = require('../constants');

// Was a second copy of the shared-token comparison. Now the same identity
// middleware as routes/admin.js, so a settings change is attributable too.
const { adminAuth } = require('../middleware/adminAuth');
const requireAdmin = adminAuth;


router.get('/cod-threshold', cacheFor(CACHE_TTL_CONFIG_S, () => 'config:cod-threshold'), getCodThreshold);
router.put('/cod-threshold', requireAdmin, async (req, res, next) => {
  await invalidateConfig('cod-threshold').catch(() => {});
  next();
}, updateCodThreshold);

router.get('/warehouse-status', getWarehouseStatus);
router.put('/warehouse-status', requireAdmin, updateWarehouseStatus);

// Cloud Scheduler tick — announces schedule-driven transitions to Slack.
// OIDC-authed (not requireAdmin): the scheduler presents a Google-signed
// identity token rather than holding an admin credential.
router.post('/warehouse-schedule-tick', requireScheduler, warehouseScheduleTick);

// Cloud Scheduler / GitHub Actions tick — posts a digest of orders awaiting
// admin acceptance. Runs every 15 min, all days (not schedule-gated: pending
// orders are themselves the alert condition). Same requireScheduler auth as
// warehouse-schedule-tick — SCHEDULER_TOKEN is endpoint-agnostic.
router.post('/pending-orders-tick', requireScheduler, pendingOrdersTick);

// Expires bulk quotes past their validUntil. Same scheduler auth as above.
router.post('/bulk-quote-expiry-tick', requireScheduler, bulkQuoteExpiryTick);

// Refreshes last-purchase prices from Zoho bills for the margin report. Same
// scheduler auth, so the cron needs no new secret.
router.post('/purchase-history-tick', requireScheduler, purchaseHistoryTick);

module.exports = router;
