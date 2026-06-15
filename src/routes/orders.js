const express = require('express');
const router = express.Router();
const { createOrder, getUserOrders, getOrderDetail, getCustomerInvoice, getCustomerInvoicePdf, cancelOrder } = require('../controllers/orderController');
const { cacheFor } = require('../cache/middleware');
const { idempotency } = require('../middleware/idempotency');
const authenticate = require('../middleware/auth');
const { CACHE_TTL_ORDER_S, CACHE_TTL_INVOICE_S } = require('../constants');

router.post('/create', idempotency(), createOrder);
router.get('/invoice/:orderId/pdf', getCustomerInvoicePdf);                                                                                               // must be before /:userId
router.get('/invoice/:orderId', cacheFor(CACHE_TTL_INVOICE_S, req => `orders:invoice:${req.params.orderId}`), getCustomerInvoice); // must be before /:userId
router.get('/detail/:orderId', cacheFor(CACHE_TTL_ORDER_S, req => `orders:detail:${req.params.orderId}`), getOrderDetail);        // must be before /:userId
router.delete('/:orderId', authenticate, cancelOrder);
router.get('/:userId', getUserOrders);

module.exports = router;
