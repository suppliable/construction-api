const express = require('express');
const router = express.Router();
const { getAllProducts } = require('../services/productService');
const { cacheFor } = require('../cache/middleware');
const { CACHE_TTL_CATALOGUE_S } = require('../constants');

// GET /api/search — full product catalogue for client-side fuzzy search
// Returns the same shape as the home catalog so ids, variant names, and stock fields are consistent
router.get('/', cacheFor(CACHE_TTL_CATALOGUE_S, () => 'search:all'), async (req, res) => {
  try {
    const products = await getAllProducts();
    const result = products.map(p => ({
      ...p,
      inStock: p.hasVariants
        ? p.variants.some(v => (v.available_stock || v.stock || 0) > 0)
        : (p.available_stock || p.stock || 0) > 0,
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
