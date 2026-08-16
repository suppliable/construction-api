const express = require('express');
const router = express.Router();
const { getCodThreshold, updateCodThreshold, getWarehouseStatus, updateWarehouseStatus, warehouseScheduleTick, pendingOrdersTick } = require('../controllers/configController');
const { requireScheduler } = require('../middleware/schedulerAuth');
const { cacheFor } = require('../cache/middleware');
const { invalidateConfig } = require('../cache/invalidate');
const { CACHE_TTL_CONFIG_S } = require('../constants');

function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Unauthorized' });
  }
  next();
}

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

module.exports = router;
