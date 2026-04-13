const express = require('express');
const router = express.Router();
const { getAllProducts } = require('../services/productService');
const categories = require('../data/categories');

// GET /api/home — full home screen data in one call
router.get('/', async (req, res) => {
  try {
    const products = await getAllProducts();
    res.json({
      success: true,
      data: { categories, products }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/home/categories — just categories
router.get('/categories', (req, res) => {
  res.json({ success: true, data: categories });
});

module.exports = router;
