const express = require('express');
const router = express.Router();
const { getAllProducts } = require('../services/productService');
const { getZohoCategories } = require('../services/zohoService');

async function buildCategories() {
  const zohoCategories = await getZohoCategories();
  return zohoCategories.map((c, index) => ({
    id: c.category_id,
    name: c.name,
    image: `https://placehold.co/200x200?text=${encodeURIComponent(c.name)}`
  }));
}

// GET /api/home — full home screen data in one call
router.get('/', async (req, res) => {
  try {
    const [categories, products] = await Promise.all([buildCategories(), getAllProducts()]);
    res.json({ success: true, data: { categories, products } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/home/categories — just categories
router.get('/categories', async (req, res) => {
  try {
    const categories = await buildCategories();
    res.json({ success: true, data: categories });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
