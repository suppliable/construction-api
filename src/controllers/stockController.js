'use strict';

// Admin FIFO stock-costing controller (generalized from the original
// cement-only tool — now covers any material). All routes are mounted
// behind the ADMIN_TOKEN middleware in routes/admin.js.

const stockRepo = require('../repositories/stockRepository');

function badRequest(res, message) {
  return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message });
}

// --- products ---

const listStockProducts = async (req, res) => {
  try {
    const products = await stockRepo.listProducts(req.traceContext);
    res.json({ success: true, data: products });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

const addStockProduct = async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const category = (req.body.category || '').trim();
    const unit = (req.body.unit || '').trim();
    if (!name) return badRequest(res, 'Item name is required');
    if (!unit) return badRequest(res, 'Unit is required (e.g. bags, tonnes, pieces)');
    const product = await stockRepo.addProduct(name, category, unit, req.traceContext);
    res.status(201).json({ success: true, data: product });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// --- restocks ---

const listStockRestocks = async (req, res) => {
  try {
    const { productId } = req.query;
    if (!productId) return badRequest(res, 'productId is required');
    const restocks = await stockRepo.listRestocks(productId, req.traceContext);
    res.json({ success: true, data: restocks });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

const addStockRestock = async (req, res) => {
  try {
    const { productId, date, note } = req.body;
    const pricePerUnit = Number(req.body.pricePerUnit);
    const qtyReceived = Number(req.body.qtyReceived);
    const stockInHand = Number(req.body.stockInHand);

    if (!productId) return badRequest(res, 'productId is required');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return badRequest(res, 'A valid date (YYYY-MM-DD) is required');
    if (!Number.isFinite(pricePerUnit) || pricePerUnit < 0) return badRequest(res, 'pricePerUnit must be a non-negative number');
    if (!Number.isFinite(qtyReceived) || qtyReceived < 0) return badRequest(res, 'qtyReceived must be a non-negative number');
    if (!Number.isFinite(stockInHand) || stockInHand < 0) return badRequest(res, 'stockInHand must be a non-negative number');

    const product = await stockRepo.getProduct(productId, req.traceContext);
    if (!product) return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Item not found' });

    const restock = await stockRepo.addRestock(
      { productId, date, pricePerUnit, qtyReceived, stockInHand, note },
      req.traceContext,
    );
    res.status(201).json({ success: true, data: restock });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

const deleteStockRestock = async (req, res) => {
  try {
    await stockRepo.deleteRestock(req.params.restockId, req.traceContext);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// --- ledger (FIFO valuation across all stock items) ---

const getStockLedger = async (req, res) => {
  try {
    const products = await stockRepo.listProducts(req.traceContext);
    const rows = await Promise.all(products.map(async (p) => {
      const restocks = await stockRepo.listRestocks(p.id, req.traceContext);
      const ledger = stockRepo.buildLedger(restocks);
      return {
        productId: p.id,
        name: p.name,
        category: p.category,
        unit: p.unit,
        onHand: ledger.onHand,
        stockValue: ledger.stockValue,
        ratePerUnit: ledger.ratePerUnit,
        layers: ledger.layers,
        anomalies: ledger.anomalies,
        lastRestockDate: restocks.length ? restocks[restocks.length - 1].date : null,
      };
    }));

    // Quantities/rates aren't summable once items use different units (bags vs
    // tonnes vs pieces), so the only cross-item total that stays meaningful is
    // the rupee stock value. Per-category/per-item breakdowns are left to the
    // admin UI, which groups `products` by `category`.
    const totalValue = rows.reduce((s, r) => s + r.stockValue, 0);

    res.json({
      success: true,
      data: {
        products: rows,
        totals: {
          totalValue: Math.round(totalValue * 100) / 100,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

module.exports = {
  listStockProducts,
  addStockProduct,
  listStockRestocks,
  addStockRestock,
  deleteStockRestock,
  getStockLedger,
};
