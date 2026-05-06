const express = require('express');
const axios = require('axios');
const multer = require('multer');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const { invalidateProducts, invalidateOrder } = require('../cache/invalidate');
const {
  getPaintPricing, setPaintPricing, listAllPaintPricing,
  getShadesByBrand, addShade, updateShade, getShadeByCode, VALID_TIERS, VALID_SIZES,
} = require('../repositories/paintRepository');
const { getGlobalReport, resetGlobal } = require('../middleware/firestoreTracker');
const { buildRuntimeDiagnostics } = require('../services/diagnosticsService');
const {
  listOrders,
  getOrderStats,
  getNewOrderCount,
  getOrderDetail,
  acceptOrder,
  declineOrder,
  forceCompleteOrder,
  cancelOrder,
  getCustomerByPhoneNumber,
  getCustomerOrders,
  markPacked,
  assignVehicle,
  getPickingList,
  getAbandonedCarts,
  getInvoiceUrl,
  getInvoicePdf,
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
  toggleFeatured,
  recordCodPayment,
  listCategories,
  uploadCategoryImage,
  deleteCategoryImage,
  listBanners,
  uploadBanner,
  updateBanner,
  deleteBanner
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

// Invalidate order detail cache only after a successful mutation response.
// Doing this pre-handler can allow a race where stale data is re-cached
// before the write commits.
const invalidateOrderAfterMutation = (req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    const statusCode = res.statusCode || 200;
    if (statusCode < 500 && req.params.orderId) {
      invalidateOrder(req.params.orderId).catch(() => {});
    }
    return originalJson(body);
  };
  next();
};

// Static routes first — must come before /:orderId to avoid conflicts
router.get('/orders/new-count', getNewOrderCount);
router.get('/orders/stats', getOrderStats);
router.get('/cod/pending', getPendingCOD);
router.post('/cod/:orderId/reconcile', invalidateOrderAfterMutation, reconcileCOD);
router.get('/cod/handovers', listHandovers);
router.post('/cod/confirm-handover/:handoverId', confirmHandover);
router.get('/cod/history', listCodHistory);

// Order list and detail
router.get('/orders', listOrders);
router.get('/orders/:orderId', getOrderDetail);

// Order actions — invalidate cached order detail after each state change
router.post('/orders/:orderId/accept', invalidateOrderAfterMutation, acceptOrder);
router.post('/orders/:orderId/decline', invalidateOrderAfterMutation, declineOrder);
router.post('/orders/:orderId/packed', invalidateOrderAfterMutation, markPacked);
router.post('/orders/:orderId/assign-vehicle', invalidateOrderAfterMutation, assignVehicle);
router.post('/orders/:orderId/force-complete', invalidateOrderAfterMutation, forceCompleteOrder);
router.post('/orders/:orderId/cancel', invalidateOrderAfterMutation, cancelOrder);
router.get('/orders/:orderId/picking-list', getPickingList);
router.get('/orders/:orderId/invoice-url', invalidateOrderAfterMutation, getInvoiceUrl);
router.get('/orders/:orderId/invoice.pdf', getInvoicePdf);
router.post('/orders/:orderId/fix-invoice', invalidateOrderAfterMutation, fixInvoice);
router.post('/orders/:orderId/record-payment', invalidateOrderAfterMutation, recordCodPayment);

// Categories
router.get('/categories', listCategories);
router.post('/categories/:categoryId/image', upload.single('image'), async (req, res, next) => {
  await invalidateProducts().catch(() => {});
  next();
}, uploadCategoryImage);
router.delete('/categories/:categoryId/image', async (req, res, next) => {
  await invalidateProducts().catch(() => {});
  next();
}, deleteCategoryImage);

// Banners
const invalidateBannersCache = async () => { await invalidateProducts().catch(() => {}); };
router.get('/banners', listBanners);
router.post('/banners', upload.single('image'), async (req, res, next) => { await invalidateBannersCache(); next(); }, uploadBanner);
router.patch('/banners/:bannerId', async (req, res, next) => { await invalidateBannersCache(); next(); }, updateBanner);
router.delete('/banners/:bannerId', async (req, res, next) => { await invalidateBannersCache(); next(); }, deleteBanner);

// Abandoned carts
router.get('/abandoned-carts', getAbandonedCarts);

// Product management — invalidate all product/home/search/category caches on featured toggle
router.put('/products/:id/featured', async (req, res, next) => {
  await invalidateProducts().catch(() => {});
  next();
}, toggleFeatured);
// Customer lookup by phone (support panel)
router.get('/customers/phone/:phone', getCustomerByPhoneNumber);
router.get('/customers/:userId/orders', getCustomerOrders);

// Vehicles
router.get('/vehicles', listVehicles);
router.post('/vehicles', createVehicle);
router.delete('/vehicles/:vehicleId', removeVehicle);

// Temp: server outbound IP — for MSG91 whitelisting
router.get('/debug/outbound-ip', async (req, res) => {
  try {
    const r = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
    res.json({ success: true, ip: r.data.ip });
  } catch (err) {
    res.status(502).json({ success: false, message: err.message });
  }
});

// Drivers
router.get('/drivers', listDrivers);
router.post('/drivers', createDriver);
router.delete('/drivers/:driverId', removeDriver);
router.post('/drivers/:driverId/set-pin', setDriverPin);

// ── Shade Management ─────────────────────────────────────────────
// GET /admin/shades/:brandSlug — list all (including inactive)
router.get('/shades/:brandSlug', async (req, res) => {
  try {
    const shades = await getShadesByBrand(req.params.brandSlug, null, true);
    res.json({ success: true, shades, total: shades.length });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

// POST /admin/shades/:brandSlug — add shade
router.post('/shades/:brandSlug', async (req, res) => {
  try {
    const { brandSlug } = req.params;
    const { code, name, tier } = req.body;
    if (!code || !name || !tier) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'code, name, and tier are required' });
    }
    if (!VALID_TIERS.includes(tier)) {
      return res.status(400).json({ success: false, error: 'INVALID_PARAM', message: `tier must be one of: ${VALID_TIERS.join(', ')}` });
    }
    const existing = await getShadeByCode(brandSlug, code);
    if (existing) {
      return res.status(409).json({ success: false, error: 'DUPLICATE_CODE', message: `Shade code '${code}' already exists` });
    }
    const shade = await addShade(brandSlug, { code, name, tier });
    res.status(201).json({ success: true, shade });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

// PUT /admin/shades/:brandSlug/:shadeId — update shade
router.put('/shades/:brandSlug/:shadeId', async (req, res) => {
  try {
    const { brandSlug, shadeId } = req.params;
    const { code, name, tier, active } = req.body;
    if (tier !== undefined && !VALID_TIERS.includes(tier)) {
      return res.status(400).json({ success: false, error: 'INVALID_PARAM', message: `tier must be one of: ${VALID_TIERS.join(', ')}` });
    }
    const updates = {};
    if (code !== undefined) updates.code = code;
    if (name !== undefined) updates.name = name;
    if (tier !== undefined) updates.tier = tier;
    if (active !== undefined) updates.active = active;
    await updateShade(brandSlug, shadeId, updates);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

// DELETE /admin/shades/:brandSlug/:shadeId — soft delete
router.delete('/shades/:brandSlug/:shadeId', async (req, res) => {
  try {
    await updateShade(req.params.brandSlug, req.params.shadeId, { active: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

// ── Paint Tier Pricing ────────────────────────────────────────────
// GET /admin/paint-pricing — list all products with pricing
router.get('/paint-pricing', async (req, res) => {
  try {
    const all = await listAllPaintPricing();
    res.json({
      success: true,
      products: all.map(p => ({
        productId: p.id,
        productName: p.productName,
        brandSlug: p.brandSlug,
        tiersConfigured: Object.keys(p.tiers || {}),
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

// POST /admin/paint-pricing/:productId — set tier pricing
router.post('/paint-pricing/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const { productName, brandSlug, tiers } = req.body;
    if (!productName || !brandSlug || !tiers) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'productName, brandSlug, and tiers are required' });
    }
    for (const tier of VALID_TIERS) {
      if (!tiers[tier]) {
        return res.status(400).json({ success: false, error: 'INVALID_PARAM', message: `Missing tier: ${tier}` });
      }
      for (const size of VALID_SIZES) {
        if (tiers[tier][size] === undefined) {
          return res.status(400).json({ success: false, error: 'INVALID_PARAM', message: `Missing price for ${tier}/${size}` });
        }
      }
    }
    await setPaintPricing(productId, { productName, brandSlug, tiers, updatedAt: new Date().toISOString() });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

// Firestore usage profiling
router.get('/firestore-usage', (req, res) => {
  res.json({ success: true, data: getGlobalReport() });
});

router.post('/firestore-usage/reset', (req, res) => {
  resetGlobal();
  res.json({ success: true, message: 'Firestore usage counters reset' });
});

// Debug: resolved environment config (secrets omitted)
router.get('/debug/config', (req, res) => {
  res.json({
    success: true,
    data: {
      ...buildRuntimeDiagnostics(),
      warehouse: {
        lat: process.env.WAREHOUSE_LAT ?? null,
        lng: process.env.WAREHOUSE_LNG ?? null,
      },
    },
  });
});

module.exports = router;
