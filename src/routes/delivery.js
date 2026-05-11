const express = require('express');
const router = express.Router();
const { calculateDeliveryCharge, getConfig, updateConfig } = require('../controllers/deliveryController');
const { cacheFor } = require('../cache/middleware');
const { invalidateDeliveryConfig } = require('../cache/invalidate');
const { CACHE_TTL_CONFIG_S } = require('../constants');

router.post('/calculate', calculateDeliveryCharge);
router.get('/config', cacheFor(CACHE_TTL_CONFIG_S, () => 'delivery:config'), getConfig);
router.put('/config', async (req, res, next) => {
  await invalidateDeliveryConfig().catch(() => {});
  next();
}, updateConfig);

module.exports = router;
