const express = require('express');
const router = express.Router();
const { loadingComplete, getEta, arrived, codCollected, completeDelivery } = require('../controllers/driverController');

router.post('/orders/:orderId/loading-complete', loadingComplete);
router.get('/orders/:orderId/eta', getEta);
router.post('/orders/:orderId/arrived', arrived);
router.post('/orders/:orderId/cod-collected', codCollected);
router.post('/orders/:orderId/complete', completeDelivery);

module.exports = router;
