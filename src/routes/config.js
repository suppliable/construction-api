const express = require('express');
const router = express.Router();
const { getCodThreshold, updateCodThreshold, getWarehouseStatus, updateWarehouseStatus } = require('../controllers/configController');
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

router.get('/warehouse-status', cacheFor(CACHE_TTL_CONFIG_S, () => 'config:warehouse-status'), getWarehouseStatus);
router.put('/warehouse-status', requireAdmin, async (req, res, next) => {
  await invalidateConfig('warehouse-status').catch(() => {});
  next();
}, updateWarehouseStatus);

module.exports = router;
