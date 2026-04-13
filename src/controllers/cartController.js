const cartService = require('../services/cartService');

function addToCart(req, res) {
  try {
    const { userId, productId, quantity } = req.body;
    if (!userId || !productId || !quantity) {
      return res.status(400).json({ error: 'userId, productId, and quantity are required' });
    }
    const cart = cartService.addToCart(userId, productId, parseInt(quantity));
    res.json({ success: true, cart });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

function updateCart(req, res) {
  try {
    const { userId, productId, quantity } = req.body;
    const cart = cartService.updateCartItem(userId, productId, parseInt(quantity));
    res.json({ success: true, cart });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

function removeFromCart(req, res) {
  try {
    const { userId, productId } = req.body;
    const cart = cartService.removeFromCart(userId, productId);
    res.json({ success: true, cart });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

function getCart(req, res) {
  try {
    const { userId } = req.params;
    const cart = cartService.buildCartResponse(userId);
    res.json(cart);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

module.exports = { addToCart, updateCart, removeFromCart, getCart };
