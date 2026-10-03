const express = require('express');
const router = express.Router();
const {
  getLowStock,
  searchItems,
  createPurchaseOrder,
  listPurchaseOrders,
  getPurchaseOrder,
  updatePurchaseOrder,
  getVendorSchedules,
  upsertVendorSchedule,
  getChecklist,
  checkVendor,
  getChecklistHistory,
} = require('../controllers/purchaseController');

// Mounted under /admin in routes/admin.js, BELOW that file's admin-token gate,
// so every route here inherits the same auth as the rest of the admin surface.

router.get('/low-stock', getLowStock);
router.get('/items/search', searchItems);

router.get('/orders', listPurchaseOrders);
router.post('/orders', createPurchaseOrder);
router.get('/orders/:poId', getPurchaseOrder);
router.put('/orders/:poId', updatePurchaseOrder);

router.get('/vendors/schedule', getVendorSchedules);
router.post('/vendors/schedule', upsertVendorSchedule);

router.get('/checklist', getChecklist);
router.get('/checklist/history', getChecklistHistory);
router.post('/checklist/:vendorId/check', checkVendor);

module.exports = router;
