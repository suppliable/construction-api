const express = require('express');
const router = express.Router();
const cartController = require('../controllers/cartController');

router.post('/add', cartController.addToCart);
router.put('/update', cartController.updateCart);
router.delete('/remove', cartController.removeFromCart);
router.get('/:userId', cartController.getCart);

module.exports = router;
