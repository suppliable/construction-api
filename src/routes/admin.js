const express = require('express');
const axios = require('axios');
const router = express.Router();
const {
  getPaintPricing, setPaintPricing, listAllPaintPricing,
  getShadesByBrand, addShade, updateShade, getShadeByCode, VALID_TIERS, VALID_SIZES,
} = require('../repositories/paintRepository');
const { getGlobalReport, resetGlobal } = require('../middleware/firestoreTracker');
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

module.exports = router;
