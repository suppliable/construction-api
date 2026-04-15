const express = require('express');
const router = express.Router();
const { getProducts, getProduct, updateProductImage } = require('../controllers/productController');

router.get('/', getProducts);
router.get('/:id', getProduct);
router.put('/:id/image', updateProductImage);

module.exports = router;
