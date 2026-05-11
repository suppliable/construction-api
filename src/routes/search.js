const express = require('express');
const router = express.Router();
const { getAllProducts } = require('../services/productService');
const { cacheFor } = require('../cache/middleware');
const { CACHE_TTL_CATALOGUE_S } = require('../constants');

// GET /api/search — lightweight product list for client-side fuzzy search
router.get('/', cacheFor(CACHE_TTL_CATALOGUE_S, () => 'search:all'), async (req, res) => {
  try {
    const products = await getAllProducts();
    const result = products.map(p => ({
      id: p.id,
      name: p.name,
      category: p.category,
      brand: p.brand,
      unit: p.unit,
      price: p.hasVariants
        ? Math.min(...p.variants.map(v => v.price || 0))
        : (p.price || 0),
      imageUrl: p.imageUrl,
      hasVariants: p.hasVariants,
      featured: p.featured,
      stock: p.stock || 0,
      available_stock: p.available_stock || 0,
      variants: p.hasVariants
        ? p.variants.map(v => ({
            id: v.id,
            name: v.name,
            price: v.price || 0,
            stock: v.stock || 0,
            available_stock: v.available_stock || 0,
          }))
        : [],
      inStock: p.hasVariants
        ? p.variants.some(v => (v.available_stock || v.stock || 0) > 0)
        : (p.available_stock || p.stock || 0) > 0
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
