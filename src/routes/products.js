const express = require('express');
const router = express.Router();
const { getProducts, getProduct, updateProductImage } = require('../controllers/productController');
const { clearCache } = require('../services/productService');
const { cacheFor } = require('../cache/middleware');
const { invalidateProducts } = require('../cache/invalidate');
const { CACHE_TTL_CATALOGUE_S } = require('../constants');

router.get('/', cacheFor(CACHE_TTL_CATALOGUE_S, req => req.query.category ? `products:all:cat:${req.query.category}` : 'products:all'), getProducts);
router.post('/cache/clear', async (req, res) => {
  clearCache();
  await invalidateProducts().catch(() => {});
  res.json({ success: true, message: 'Product cache cleared' });
});
router.get('/:id', cacheFor(CACHE_TTL_CATALOGUE_S, req => `products:id:${req.params.id}`), getProduct);
router.put('/:id/image', updateProductImage);

module.exports = router;
