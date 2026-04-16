const express = require('express');
const router = express.Router();
const { getCustomer, updateDeliveryAddress, updateRegisteredAddress, listCustomers, getCustomerByPhone } = require('../controllers/customerController');

router.get('/', listCustomers);
router.get('/phone/:phone', getCustomerByPhone);
router.get('/:userId', getCustomer);
router.put('/:userId/delivery-address', updateDeliveryAddress);
router.put('/:userId/registered-address', updateRegisteredAddress);

module.exports = router;
