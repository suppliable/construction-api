const express = require('express');
const router = express.Router();
const { getAllProducts } = require('../services/productService');

// GET /api/categories/:category?page=1&limit=20
router.get('/:category', async (req, res) => {
  try {
    const { category } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));

    const all = await getAllProducts();
    const filtered = all.filter(p => p.category.toLowerCase() === category.toLowerCase());

    const total = filtered.length;
    const totalPages = Math.ceil(total / limit) || 0;
    const start = (page - 1) * limit;
    const products = filtered.slice(start, start + limit);

    res.json({
      success: true,
      category: filtered[0]?.category || category,
      total,
      page,
      limit,
      totalPages,
      products
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
