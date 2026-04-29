const express = require('express');
const router = express.Router();
const { createOrder, getUserOrders, getOrderDetail, getCustomerInvoice } = require('../controllers/orderController');
const { cacheFor } = require('../cache/middleware');
const { CACHE_TTL_ORDER_S, CACHE_TTL_INVOICE_S } = require('../constants');

router.post('/create', createOrder);
router.get('/invoice/:orderId', cacheFor(CACHE_TTL_INVOICE_S, req => `orders:invoice:${req.params.orderId}`), getCustomerInvoice); // must be before /:userId
router.get('/detail/:orderId', cacheFor(CACHE_TTL_ORDER_S, req => `orders:detail:${req.params.orderId}`), getOrderDetail);        // must be before /:userId
router.get('/:userId', getUserOrders);

module.exports = router;
