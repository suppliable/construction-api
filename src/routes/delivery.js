const express = require('express');
const router = express.Router();
const { calculateDeliveryCharge, getConfig, updateConfig } = require('../controllers/deliveryController');

router.post('/calculate', calculateDeliveryCharge);
router.get('/config', getConfig);
router.put('/config', updateConfig);

module.exports = router;
