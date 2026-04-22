const express = require('express');
const router = express.Router();
const { getAllProducts } = require('../services/productService');

// GET /api/home
router.get('/', async (req, res) => {
  try {
    const products = await getAllProducts();

    const categories = [...new Set(products.map(p => p.category).filter(Boolean))].sort();

    const featured = products.filter(p => p.featured).slice(0, 20);

    const preview = {};
    categories.forEach(cat => {
      preview[cat] = products.filter(p => p.category === cat).slice(0, 5);
    });

    res.json({ success: true, data: { categories, featured, preview } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
