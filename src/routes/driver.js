const express = require('express');
const router = express.Router();
const driverAuth = require('../middleware/driverAuth');
const { driverAuth: driverLogin, loadingComplete, getEta, updateDriverLocation, arrived, codCollected, completeDelivery, getDriverProfile, updateDriverStatus, getTodayOrders, getDriverOrderDetail, getCodSummary, submitHandover, getDriverCodHistory } = require('../controllers/driverController');
const { cacheFor } = require('../cache/middleware');
const { CACHE_TTL_DRIVER_PROFILE_S, CACHE_TTL_DRIVER_ORDERS_S } = require('../constants');
const { buildRuntimeDiagnostics, ensureAllowlistedAdminPhone } = require('../services/diagnosticsService');

// Public — no auth
router.post('/auth', driverLogin);

// All routes below require driver token
router.use(driverAuth);

router.get('/profile', cacheFor(CACHE_TTL_DRIVER_PROFILE_S, req => `driver:profile:${req.driver.driverId}`), getDriverProfile);
router.patch('/status', updateDriverStatus);

const todayDate = () => new Date().toISOString().slice(0, 10);
router.get('/orders/today', cacheFor(CACHE_TTL_DRIVER_ORDERS_S, req => `driver:orders:today:${req.driver.driverId}:${todayDate()}`), getTodayOrders);
router.get('/orders/:orderId', getDriverOrderDetail);

router.get('/cod/summary', getCodSummary);
router.post('/cod/handover', submitHandover);
router.get('/cod/history', getDriverCodHistory);

router.get('/environment-info', async (req, res, next) => {
  try {
    await ensureAllowlistedAdminPhone(req.driver.phone);
    return res.json({
      success: true,
      data: buildRuntimeDiagnostics(),
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/orders/:orderId/location', updateDriverLocation);
router.post('/orders/:orderId/loading-complete', loadingComplete);
router.get('/orders/:orderId/eta', getEta);
router.post('/orders/:orderId/arrived', arrived);
router.post('/orders/:orderId/cod-collected', codCollected);
router.post('/orders/:orderId/complete', completeDelivery);

module.exports = router;
