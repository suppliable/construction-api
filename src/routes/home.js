const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();
const { getAllProducts } = require('../services/productService');
const { cacheFor } = require('../cache/middleware');
const { CACHE_TTL_CATALOGUE_S } = require('../constants');

function toCategoryId(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// GET /api/home
router.get('/', cacheFor(CACHE_TTL_CATALOGUE_S, () => 'home:data'), async (req, res) => {
  try {
    const [products, catSnap] = await Promise.all([
      getAllProducts(null, req.traceContext),
      admin.firestore().collection('categories').get()
    ]);

    const categoryImages = {};
    catSnap.docs.forEach(d => { categoryImages[d.id] = d.data().imageUrl || null; });

    const catMap = {};
    products.forEach(p => {
      if (!p.category) return;
      const id = toCategoryId(p.category);
      if (!catMap[id]) catMap[id] = { id, name: p.category, productCount: 0 };
      catMap[id].productCount++;
    });

    const categories = Object.values(catMap)
      .map(cat => ({ ...cat, imageUrl: categoryImages[cat.id] || null }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const featured = products.filter(p => p.featured).slice(0, 20);

    const preview = {};
    categories.forEach(cat => {
      preview[cat.name] = products.filter(p => p.category === cat.name).slice(0, 5);
    });

    res.json({ success: true, data: { categories, featured, preview } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
