'use strict';

const express = require('express');
const router = express.Router();
const { getPaintPricing, VALID_TIERS, VALID_SIZES } = require('../repositories/paintRepository');

// GET /api/v1/paint-pricing/:productId
router.get('/:productId/calculate', async (req, res) => {
  try {
    const { productId } = req.params;
    const { tier, size } = req.query;

    if (!tier || !size) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'tier and size are required' });
    }
    if (!VALID_TIERS.includes(tier)) {
      return res.status(400).json({ success: false, error: 'INVALID_PARAM', message: `tier must be one of: ${VALID_TIERS.join(', ')}` });
    }
    if (!VALID_SIZES.includes(size)) {
      return res.status(400).json({ success: false, error: 'INVALID_PARAM', message: `size must be one of: ${VALID_SIZES.join(', ')}` });
    }

    const pricing = await getPaintPricing(productId);
    if (!pricing) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'No pricing configured for this product' });
    }

    const price = pricing.tiers?.[tier]?.[size];
    if (price === undefined) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND', message: `No price set for tier '${tier}' size '${size}'` });
    }

    res.json({ success: true, productId, tier, size, price });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

router.get('/:productId', async (req, res) => {
  try {
    const pricing = await getPaintPricing(req.params.productId);
    if (!pricing) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'No pricing configured for this product' });
    }
    res.json({ success: true, productId: req.params.productId, ...pricing });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

module.exports = router;
