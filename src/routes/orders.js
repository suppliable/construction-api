const express = require('express');
const router = express.Router();
const { createOrder, getUserOrders, getOrderDetail } = require('../controllers/orderController');

router.post('/create', createOrder);
router.get('/detail/:orderId', getOrderDetail); // must be before /:userId
router.get('/:userId', getUserOrders);

module.exports = router;
