const express = require('express');
const router = express.Router();
const categories = require('../data/categories');
const products = require('../data/products');

router.get('/', (req, res) => {
  const homeData = {
    categories,
    products: products.map(p => ({
      id: p.id,
      name: p.name,
      brand: p.brand,
      category: p.category,
      description: p.description,
      image: p.image,
      fallbackImage: p.fallbackImage,
      hasVariants: p.hasVariants,
      ...(p.hasVariants
        ? { priceRange: p.priceRange, variants: p.variants }
        : { price: p.price }),
      gst_percentage: p.gst_percentage,
      unit: p.unit
    }))
  };
  res.json({ success: true, data: homeData });
});

router.get('/categories', (req, res) => {
  res.json({ success: true, data: categories });
});

module.exports = router;
