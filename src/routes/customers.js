const express = require('express');
const router = express.Router();
const { getCustomer, updateDeliveryAddress, updateRegisteredAddress } = require('../controllers/customerController');

router.get('/:userId', getCustomer);
router.put('/:userId/delivery-address', updateDeliveryAddress);
router.put('/:userId/registered-address', updateRegisteredAddress);

module.exports = router;
