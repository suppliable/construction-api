const express = require('express');
const router = express.Router();
const driverAuth = require('../middleware/driverAuth');
const { driverAuth: driverLogin, loadingComplete, getEta, arrived, codCollected, completeDelivery } = require('../controllers/driverController');

// Public — no auth
router.post('/auth', driverLogin);

// All routes below require driver token
router.use(driverAuth);

router.post('/orders/:orderId/loading-complete', loadingComplete);
router.get('/orders/:orderId/eta', getEta);
router.post('/orders/:orderId/arrived', arrived);
router.post('/orders/:orderId/cod-collected', codCollected);
router.post('/orders/:orderId/complete', completeDelivery);

module.exports = router;
