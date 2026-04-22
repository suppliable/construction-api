const express = require('express');
const router = express.Router();
const { getAllProducts } = require('../services/productService');

// GET /api/search — lightweight product list for client-side fuzzy search
router.get('/', async (req, res) => {
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
