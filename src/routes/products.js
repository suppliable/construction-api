const express = require('express');
const router = express.Router();
const { getProducts, getProduct, updateProductImage } = require('../controllers/productController');
const { clearCache } = require('../services/productService');

router.get('/', getProducts);
router.post('/cache/clear', (req, res) => {
  clearCache();
  res.json({ success: true, message: 'Product cache cleared' });
});
router.get('/:id', getProduct);
router.put('/:id/image', updateProductImage);

module.exports = router;
