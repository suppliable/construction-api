const express = require('express');
const axios = require('axios');
const multer = require('multer');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const { invalidateProducts, invalidateOrder, invalidateAfterZohoMutation } = require('../cache/invalidate');
const remoteConfig = require('../services/remoteConfigService');
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
  markPaymentReceived,
  forceCompleteOrder,
  cancelOrder,
  getCustomerByPhoneNumber,
  getCustomerByUserId,
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
router.post('/orders/:orderId/mark-payment-received', invalidateOrderAfterMutation, markPaymentReceived);
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
router.get('/customers/:userId', getCustomerByUserId);

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
    const { code, name, tier, hex } = req.body;
    if (!code || !name || !tier) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'code, name, and tier are required' });
    }
    if (!VALID_TIERS.includes(tier)) {
      return res.status(400).json({ success: false, error: 'INVALID_PARAM', message: `tier must be one of: ${VALID_TIERS.join(', ')}` });
    }
    if (hex !== undefined && !/^#[0-9A-Fa-f]{6}$/.test(hex)) {
      return res.status(400).json({ success: false, error: 'INVALID_PARAM', message: 'hex must be a valid 6-digit hex color (e.g. #F7E2E0)' });
    }
    const existing = await getShadeByCode(brandSlug, code);
    if (existing) {
      return res.status(409).json({ success: false, error: 'DUPLICATE_CODE', message: `Shade code '${code}' already exists` });
    }
    const shadeData = { code, name, tier };
    if (hex) shadeData.hex = hex;
    const shade = await addShade(brandSlug, shadeData);
    res.status(201).json({ success: true, shade });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

// PUT /admin/shades/:brandSlug/:shadeId — update shade
router.put('/shades/:brandSlug/:shadeId', async (req, res) => {
  try {
    const { brandSlug, shadeId } = req.params;
    const { code, name, tier, active, hex } = req.body;
    if (tier !== undefined && !VALID_TIERS.includes(tier)) {
      return res.status(400).json({ success: false, error: 'INVALID_PARAM', message: `tier must be one of: ${VALID_TIERS.join(', ')}` });
    }
    if (hex !== undefined && !/^#[0-9A-Fa-f]{6}$/.test(hex)) {
      return res.status(400).json({ success: false, error: 'INVALID_PARAM', message: 'hex must be a valid 6-digit hex color (e.g. #F7E2E0)' });
    }
    const updates = {};
    if (code !== undefined) updates.code = code;
    if (name !== undefined) updates.name = name;
    if (tier !== undefined) updates.tier = tier;
    if (active !== undefined) updates.active = active;
    if (hex !== undefined) updates.hex = hex;
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

// Manual cache invalidation — flush Zoho-derived caches (products, home, search, categories)
// after editing items directly in Zoho so users see fresh data without waiting for TTL.
// Multi-instance caveat: Redis keys are cleared globally, but per-instance in-memory caches
// (productService, remoteConfig) only clear on the Cloud Run instance handling this request.
// Other warm instances continue serving from their own in-memory state until TTL expires
// (10 min default), after which they refill from Redis.
router.post('/cache/invalidate-zoho', async (req, res) => {
  try {
    await invalidateAfterZohoMutation('manual', '/admin/cache/invalidate-zoho');
    remoteConfig.clearCache();
    res.json({ success: true, message: 'Zoho caches cleared' });
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

// ── POS endpoints ─────────────────────────────────────────────────
const {
  searchCustomers,
  createCustomer,
  getCustomerAddresses,
  addCustomerAddress,
  savePOSDraft,
  getPOSDraft,
  updatePOSDraft,
  createPOSQuotation,
  convertPOSDraftToOrder,
  listPOSDrafts,
  discardPOSDraft,
  getPOSQuotationPDF,
} = require('../services/posService');

// Customer search — GET /admin/pos/customers/search?q=
router.get('/pos/customers/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'q must be at least 2 characters' });
    }
    const customers = await searchCustomers(q, req.traceContext);
    res.json({ success: true, data: { customers } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

// Create customer — POST /admin/pos/customers
router.post('/pos/customers', async (req, res) => {
  try {
    const { name, phone, email } = req.body;
    const customer = await createCustomer({ name, phone, email }, req.traceContext);
    res.status(201).json({ success: true, data: { customer } });
  } catch (err) {
    if (err.code === 'MISSING_PARAM') return res.status(400).json({ success: false, error: err.code, message: err.message });
    if (err.code === 'DUPLICATE_PHONE') return res.status(409).json({ success: false, error: err.code, message: err.message });
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

// Get customer addresses — GET /admin/pos/customers/:userId/addresses
router.get('/pos/customers/:userId/addresses', async (req, res) => {
  try {
    const addresses = await getCustomerAddresses(req.params.userId, req.traceContext);
    res.json({ success: true, data: { addresses } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

// Add customer address — POST /admin/pos/customers/:userId/addresses
router.post('/pos/customers/:userId/addresses', async (req, res) => {
  try {
    const { fullAddress, lat, lng, label } = req.body;
    const address = await addCustomerAddress(req.params.userId, { fullAddress, lat, lng, label }, req.traceContext);
    res.status(201).json({ success: true, data: { address } });
  } catch (err) {
    if (err.code === 'MISSING_PARAM') return res.status(400).json({ success: false, error: err.code, message: err.message });
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

// Create draft — POST /admin/pos/drafts
router.post('/pos/drafts', async (req, res) => {
  try {
    const { customerId, addressId, items, gstNumber } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'items array is required' });
    }
    const draft = await savePOSDraft({ customerId, addressId, items, gstNumber }, req.traceContext);
    res.status(201).json({ success: true, data: { draft } });
  } catch (err) {
    if (err.code === 'MISSING_PARAM' || err.code === 'INVALID_PARAM') return res.status(400).json({ success: false, error: err.code, message: err.message });
    if (err.code === 'PRODUCT_NOT_FOUND') return res.status(404).json({ success: false, error: err.code, message: err.message });
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

// Get draft — GET /admin/pos/drafts/:draftId
router.get('/pos/drafts/:draftId', async (req, res) => {
  try {
    const draft = await getPOSDraft(req.params.draftId, req.traceContext);
    if (!draft) return res.status(404).json({ success: false, error: 'DRAFT_NOT_FOUND', message: 'Draft not found' });
    res.json({ success: true, data: { draft } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

// Update draft — PUT /admin/pos/drafts/:draftId
router.put('/pos/drafts/:draftId', async (req, res) => {
  try {
    const { customerId, addressId, items, gstNumber } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'items array is required' });
    }
    const draft = await updatePOSDraft(req.params.draftId, { customerId, addressId, items, gstNumber }, req.traceContext);
    if (!draft) return res.status(404).json({ success: false, error: 'DRAFT_NOT_FOUND', message: 'Draft not found' });
    res.json({ success: true, data: { draft } });
  } catch (err) {
    if (err.code === 'MISSING_PARAM' || err.code === 'INVALID_PARAM') return res.status(400).json({ success: false, error: err.code, message: err.message });
    if (err.code === 'PRODUCT_NOT_FOUND') return res.status(404).json({ success: false, error: err.code, message: err.message });
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

// Create quotation — POST /admin/pos/drafts/:draftId/quotation
router.post('/pos/drafts/:draftId/quotation', async (req, res) => {
  try {
    const result = await createPOSQuotation(req.params.draftId, req.traceContext);
    res.json({ success: true, data: result });
  } catch (err) {
    if (err.code === 'DRAFT_NOT_FOUND') return res.status(404).json({ success: false, error: err.code, message: err.message });
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

// Convert draft to order — POST /admin/pos/drafts/:draftId/convert
router.post('/pos/drafts/:draftId/convert', async (req, res) => {
  try {
    const { paymentMethod } = req.body;
    const order = await convertPOSDraftToOrder(req.params.draftId, { paymentMethod }, req.traceContext);
    res.status(201).json({ success: true, data: { order } });
  } catch (err) {
    if (err.code === 'DRAFT_NOT_FOUND') return res.status(404).json({ success: false, error: err.code, message: err.message });
    if (err.code === 'INVALID_STATUS') return res.status(409).json({ success: false, error: err.code, message: err.message });
    if (err.code === 'WAREHOUSE_CLOSED') return res.status(503).json({ success: false, error: err.code, message: err.message });
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

// Discard a POS draft — PATCH /admin/pos/drafts/:draftId/discard
router.patch('/pos/drafts/:draftId/discard', async (req, res) => {
  try {
    await discardPOSDraft(req.params.draftId, req.traceContext);
    res.json({ success: true });
  } catch (e) {
    const status = e.code === 'DRAFT_NOT_FOUND' ? 404 : e.code === 'ALREADY_CONVERTED' ? 400 : 500;
    res.status(status).json({ success: false, message: e.message });
  }
});

// List active POS drafts — GET /admin/pos/drafts
router.get('/pos/drafts', async (req, res) => {
  try {
    const drafts = await listPOSDrafts(req.traceContext);
    res.json({ success: true, data: { drafts } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Generate/fetch PDF for a POS quotation — POST /admin/pos/drafts/:draftId/pdf
router.post('/pos/drafts/:draftId/pdf', async (req, res) => {
  try {
    const { draftId } = req.params;
    const result = await getPOSQuotationPDF(draftId, req.traceContext);
    res.json({ success: true, data: result });
  } catch (e) {
    const status = e.code === 'DRAFT_NOT_FOUND' ? 404 : e.code === 'NO_QUOTATION' ? 400 : 500;
    res.status(status).json({ success: false, message: e.message });
  }
});

// Maps API key — GET /admin/pos/maps-key
// Prefers GOOGLE_MAPS_FRONTEND_KEY (unrestricted browser key) over the
// server-side GOOGLE_MAPS_API_KEY which may have IP restrictions.
router.get('/pos/maps-key', (req, res) => {
  const apiKey = process.env.GOOGLE_MAPS_FRONTEND_KEY || process.env.GOOGLE_MAPS_API_KEY || null;
  res.json({ success: true, data: { apiKey } });
});

module.exports = router;
