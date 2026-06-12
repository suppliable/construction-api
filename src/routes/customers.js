const express = require('express');
const router = express.Router();
const { getCustomer, updateDeliveryAddress, updateRegisteredAddress, updateGSTDetails, removeGSTDetails, listCustomers, getCustomerByPhone } = require('../controllers/customerController');

router.get('/', listCustomers);
router.get('/phone/:phone', getCustomerByPhone);
router.get('/:userId', getCustomer);
router.put('/:userId/delivery-address', updateDeliveryAddress);
router.put('/:userId/registered-address', updateRegisteredAddress);
router.put('/:userId/gst', updateGSTDetails);
router.delete('/:userId/gst', removeGSTDetails);

module.exports = router;
