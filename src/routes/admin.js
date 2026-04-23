const express = require('express');
const router = express.Router();
const {
  listOrders,
  getNewOrderCount,
  getOrderDetail,
  acceptOrder,
  declineOrder,
  getCustomerByPhoneNumber,
  getCustomerOrders,
  markPacked,
  assignVehicle,
  getPickingList,
  getInvoiceUrl,
  fixInvoice,
  getPendingCOD,
  reconcileCOD,
  listHandovers,
  confirmHandover,
  listCodHistory,
  listVehicles,
  createVehicle,
  removeVehicle,
  listDrivers,
  createDriver,
  removeDriver,
  setDriverPin,
  toggleFeatured
} = require('../controllers/adminController');

// Auth — no middleware on this route
router.post('/auth', (req, res) => {
  const { password } = req.body;
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: 'INVALID_PASSWORD', message: 'Invalid password' });
  }
  res.json({ success: true, data: { token: process.env.ADMIN_TOKEN } });
});

// Middleware: all routes below require valid token
router.use((req, res, next) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Unauthorized' });
  }
  next();
});

// Static routes first — must come before /:orderId to avoid conflicts
router.get('/orders/new-count', getNewOrderCount);
router.get('/cod/pending', getPendingCOD);
router.post('/cod/:orderId/reconcile', reconcileCOD);
router.get('/cod/handovers', listHandovers);
router.post('/cod/confirm-handover/:handoverId', confirmHandover);
router.get('/cod/history', listCodHistory);

// Order list and detail
router.get('/orders', listOrders);
router.get('/orders/:orderId', getOrderDetail);

// Order actions
router.post('/orders/:orderId/accept', acceptOrder);
router.post('/orders/:orderId/decline', declineOrder);
router.post('/orders/:orderId/packed', markPacked);
router.post('/orders/:orderId/assign-vehicle', assignVehicle);
router.get('/orders/:orderId/picking-list', getPickingList);
router.get('/orders/:orderId/invoice-url', getInvoiceUrl);
router.post('/orders/:orderId/fix-invoice', fixInvoice);

// Product management
router.put('/products/:id/featured', toggleFeatured);
// Customer lookup by phone (support panel)
router.get('/customers/phone/:phone', getCustomerByPhoneNumber);
router.get('/customers/:userId/orders', getCustomerOrders);

// Vehicles
router.get('/vehicles', listVehicles);
router.post('/vehicles', createVehicle);
router.delete('/vehicles/:vehicleId', removeVehicle);

// Drivers
router.get('/drivers', listDrivers);
router.post('/drivers', createDriver);
router.delete('/drivers/:driverId', removeDriver);
router.post('/drivers/:driverId/set-pin', setDriverPin);

module.exports = router;
