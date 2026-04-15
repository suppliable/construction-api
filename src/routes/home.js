const express = require('express');
const router = express.Router();
const { getAllProducts } = require('../services/productService');
const { getZohoItemGroups, getZohoProducts } = require('../services/zohoService');

async function buildCategories() {
  const [groups, items] = await Promise.all([getZohoItemGroups(), getZohoProducts()]);

  const seen = new Set();
  const categories = [];

  for (const g of groups) {
    const name = g.category_name;
    if (name && !seen.has(name)) {
      seen.add(name);
      categories.push(name);
    }
  }

  for (const item of items) {
    const name = item.category_name;
    if (name && !seen.has(name)) {
      seen.add(name);
      categories.push(name);
    }
  }

  return categories.map((name, index) => ({
    id: index + 1,
    name,
    image: `https://placehold.co/200x200?text=${encodeURIComponent(name)}`
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
