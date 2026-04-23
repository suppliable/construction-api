const cartService = require('../services/cartService');
const { getCart: getRawCart } = require('../data/cart');
const { getProductById } = require('../services/productService');

async function clearCart(req, res) {
  try {
    const { userId } = req.params;
    const result = await cartService.clearCart(userId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: 'BAD_REQUEST', message: err.message });
  }
}

async function setDeliveryCharge(req, res) {
  try {
    const { userId } = req.params;
    const { deliveryCharge, addressId } = req.body;
    if (deliveryCharge === undefined || deliveryCharge === null) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'deliveryCharge is required' });
    }
    const result = await cartService.setDeliveryCharge(userId, parseFloat(deliveryCharge), addressId || null);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: 'BAD_REQUEST', message: err.message });
  }
}

async function addToCart(req, res) {
  try {
    const { userId, productId, quantity } = req.body;
    if (!userId || !productId || !quantity) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'userId, productId, and quantity are required' });
    }
    const result = await cartService.addToCart(userId, productId, parseInt(quantity));
    res.json({ success: true, data: result });
  } catch (err) {
    const isStockError = /out of stock|units available/i.test(err.message);
    res.status(400).json({ success: false, error: isStockError ? 'STOCK_ISSUE' : 'BAD_REQUEST', message: err.message });
  }
}

async function updateCart(req, res) {
  try {
    const { userId, productId, quantity } = req.body;
    const result = await cartService.updateCartItem(userId, productId, parseInt(quantity));
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: 'BAD_REQUEST', message: err.message });
  }
}

async function removeFromCart(req, res) {
  try {
    const { userId, productId } = req.body;
    const result = await cartService.removeFromCart(userId, productId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: 'BAD_REQUEST', message: err.message });
  }
}

async function getCart(req, res) {
  try {
    const { userId } = req.params;
    const result = await cartService.buildCartResponse(userId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: 'BAD_REQUEST', message: err.message });
  }
}

async function validateCart(req, res) {
  try {
    const { userId } = req.params;
    const cart = await getRawCart(userId);
    const issues = [];

    await Promise.all((cart.items || []).map(async (item) => {
      const product = await getProductById(item.productId, req.traceContext);
      if (!product) {
        issues.push({ productId: item.productId, message: 'Product not found' });
        return;
      }
      if (product.available_stock !== undefined && product.available_stock !== null) {
        if (item.quantity > product.available_stock) {
          issues.push({
            productId: item.productId,
            productName: product.name,
            requested: item.quantity,
            available: product.available_stock,
            message: product.available_stock <= 0
              ? `${product.name} is out of stock`
              : `Only ${product.available_stock} units available for ${product.name}`
          });
        }
      }
    }));

    res.json({ success: true, data: { valid: issues.length === 0, issues } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
}

module.exports = { addToCart, updateCart, removeFromCart, getCart, setDeliveryCharge, validateCart, clearCart };
