'use strict';

// Admin cement FIFO stock-costing controller. All routes are mounted behind the
// ADMIN_TOKEN middleware in routes/admin.js.

const cementRepo = require('../repositories/cementRepository');

function badRequest(res, message) {
  return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message });
}

// --- products ---

const listCementProducts = async (req, res) => {
  try {
    const products = await cementRepo.listProducts(req.traceContext);
    res.json({ success: true, data: products });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

const addCementProduct = async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return badRequest(res, 'Cement name is required');
    const product = await cementRepo.addProduct(name, req.traceContext);
    res.status(201).json({ success: true, data: product });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// --- restocks ---

const listCementRestocks = async (req, res) => {
  try {
    const { productId } = req.query;
    if (!productId) return badRequest(res, 'productId is required');
    const restocks = await cementRepo.listRestocks(productId, req.traceContext);
    res.json({ success: true, data: restocks });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

const addCementRestock = async (req, res) => {
  try {
    const { productId, date, note } = req.body;
    const landingPricePerBag = Number(req.body.landingPricePerBag);
    const bagsReceived = Number(req.body.bagsReceived);
    const stockInHand = Number(req.body.stockInHand);

    if (!productId) return badRequest(res, 'productId is required');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return badRequest(res, 'A valid date (YYYY-MM-DD) is required');
    if (!Number.isFinite(landingPricePerBag) || landingPricePerBag < 0) return badRequest(res, 'landingPricePerBag must be a non-negative number');
    if (!Number.isFinite(bagsReceived) || bagsReceived < 0) return badRequest(res, 'bagsReceived must be a non-negative number');
    if (!Number.isFinite(stockInHand) || stockInHand < 0) return badRequest(res, 'stockInHand must be a non-negative number');

    const product = await cementRepo.getProduct(productId, req.traceContext);
    if (!product) return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Cement product not found' });

    const restock = await cementRepo.addRestock(
      { productId, date, landingPricePerBag, bagsReceived, stockInHand, note },
      req.traceContext,
    );
    res.status(201).json({ success: true, data: restock });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

const deleteCementRestock = async (req, res) => {
  try {
    await cementRepo.deleteRestock(req.params.restockId, req.traceContext);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// --- ledger (FIFO valuation across all cement products) ---

const getCementLedger = async (req, res) => {
  try {
    const products = await cementRepo.listProducts(req.traceContext);
    const rows = await Promise.all(products.map(async (p) => {
      const restocks = await cementRepo.listRestocks(p.id, req.traceContext);
      const ledger = cementRepo.buildLedger(restocks);
      return {
        productId: p.id,
        name: p.name,
        onHand: ledger.onHand,
        stockValue: ledger.stockValue,
        ratePerBag: ledger.ratePerBag,
        layers: ledger.layers,
        anomalies: ledger.anomalies,
        lastRestockDate: restocks.length ? restocks[restocks.length - 1].date : null,
      };
    }));

    const totalValue = rows.reduce((s, r) => s + r.stockValue, 0);
    const totalBags = rows.reduce((s, r) => s + r.onHand, 0);

    res.json({
      success: true,
      data: {
        products: rows,
        totals: {
          totalBags,
          totalValue: Math.round(totalValue * 100) / 100,
          blendedRatePerBag: totalBags > 0 ? Math.round((totalValue / totalBags) * 100) / 100 : 0,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

module.exports = {
  listCementProducts,
  addCementProduct,
  listCementRestocks,
  addCementRestock,
  deleteCementRestock,
  getCementLedger,
};
