const express = require('express');
const router = express.Router();
const driverAuth = require('../middleware/driverAuth');
const { driverAuth: driverLogin, loadingComplete, getEta, updateDriverLocation, arrived, codCollected, completeDelivery, getDriverProfile, updateDriverStatus, getTodayOrders, getDriverOrderDetail, getCodSummary, submitHandover, getDriverCodHistory } = require('../controllers/driverController');
const { cacheFor } = require('../cache/middleware');
const { invalidateOrder, invalidateDriverOrders, invalidateDriverProfile } = require('../cache/invalidate');
const { CACHE_TTL_DRIVER_PROFILE_S, CACHE_TTL_DRIVER_ORDERS_S } = require('../constants');
const { buildRuntimeDiagnostics, ensureAllowlistedAdminPhone } = require('../services/diagnosticsService');

// Invalidate caches only after a successful mutation response, to avoid
// races where a concurrent read re-caches stale data before the write commits.
const invalidateAfterMutation = ({ order = false, driverOrders = false, driverProfile = false } = {}) =>
  (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const statusCode = res.statusCode || 200;
      if (statusCode < 500) {
        if (order && req.params.orderId) invalidateOrder(req.params.orderId).catch(() => {});
        const driverId = req.driver?.driverId;
        if (driverOrders && driverId) invalidateDriverOrders(driverId).catch(() => {});
        if (driverProfile && driverId) invalidateDriverProfile(driverId).catch(() => {});
      }
      return originalJson(body);
    };
    next();
  };

// Public — no auth
router.post('/auth', driverLogin);

// All routes below require driver token
router.use(driverAuth);

router.get('/profile', cacheFor(CACHE_TTL_DRIVER_PROFILE_S, req => `driver:profile:${req.driver.driverId}`), getDriverProfile);
router.patch('/status', invalidateAfterMutation({ driverProfile: true }), updateDriverStatus);

const todayDate = () => new Date().toISOString().slice(0, 10);
router.get('/orders/today', cacheFor(CACHE_TTL_DRIVER_ORDERS_S, req => `driver:orders:today:${req.driver.driverId}:${todayDate()}`), getTodayOrders);
router.get('/orders/:orderId', getDriverOrderDetail);

router.get('/cod/summary', getCodSummary);
router.post('/cod/handover', invalidateAfterMutation({ driverOrders: true }), submitHandover);
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
router.post('/orders/:orderId/loading-complete', invalidateAfterMutation({ order: true, driverOrders: true }), loadingComplete);
router.get('/orders/:orderId/eta', getEta);
router.post('/orders/:orderId/arrived', invalidateAfterMutation({ order: true, driverOrders: true }), arrived);
router.post('/orders/:orderId/cod-collected', invalidateAfterMutation({ order: true, driverOrders: true }), codCollected);
router.post('/orders/:orderId/complete', invalidateAfterMutation({ order: true, driverOrders: true }), completeDelivery);

module.exports = router;
