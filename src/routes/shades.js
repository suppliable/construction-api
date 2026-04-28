'use strict';

const express = require('express');
const router = express.Router();
const { getShadesByBrand, getBrandDoc } = require('../repositories/paintRepository');

// GET /api/v1/shades/:brandSlug?q=
router.get('/:brandSlug', async (req, res) => {
  try {
    const { brandSlug } = req.params;
    const { q } = req.query;

    const brand = await getBrandDoc(brandSlug);
    if (!brand) {
      return res.status(404).json({ success: false, error: 'BRAND_NOT_FOUND', message: `Brand '${brandSlug}' not found` });
    }

    const shades = await getShadesByBrand(brandSlug, q || null);
    res.json({
      success: true,
      brandSlug,
      brandName: brand.brandName,
      shades: shades.map(s => ({ id: s.id, code: s.code, name: s.name, tier: s.tier })),
      total: shades.length,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

module.exports = router;
