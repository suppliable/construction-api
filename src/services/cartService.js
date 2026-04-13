const { getCart, saveCart } = require('../data/cart');
const { getProductById } = require('./productService');
const { calculateItemPrice } = require('../utils/gstCalculator');

function addToCart(userId, productId, quantity) {
  const cart = getCart(userId);

  const existingItem = cart.items.find(i => i.productId === productId);
  if (existingItem) {
    existingItem.quantity += quantity;
  } else {
    cart.items.push({ productId, quantity });
  }

  saveCart(userId, cart);
  return buildCartResponse(userId);
}

function updateCartItem(userId, productId, quantity) {
  const cart = getCart(userId);

  if (quantity <= 0) {
    cart.items = cart.items.filter(i => i.productId !== productId);
  } else {
    const item = cart.items.find(i => i.productId === productId);
    if (!item) throw new Error(`Item ${productId} not in cart`);
    item.quantity = quantity;
  }

  saveCart(userId, cart);
  return buildCartResponse(userId);
}

function removeFromCart(userId, productId) {
  const cart = getCart(userId);
  cart.items = cart.items.filter(i => i.productId !== productId);
  saveCart(userId, cart);
  return buildCartResponse(userId);
}

async function buildCartResponse(userId) {
  const cart = getCart(userId);

  let grandTotal = 0;
  let totalGST = 0;

  const items = await Promise.all(cart.items.map(async (item) => {
    const product = await getProductById(item.productId);
    if (!product) return null;

    const subtotal = parseFloat((product.price * item.quantity).toFixed(2));
    const gstAmount = parseFloat((subtotal * product.gst_percentage / 100).toFixed(2));
    const totalWithGST = parseFloat((subtotal + gstAmount).toFixed(2));

    grandTotal += totalWithGST;
    totalGST += gstAmount;

    return {
      productId: item.productId,
      name: product.name,
      quantity: item.quantity,
      unitPrice: product.price,
      gstRate: product.gst_percentage,
      subtotal,
      gstAmount,
      totalWithGST
    };
  }));

  const validItems = items.filter(Boolean);

  return {
    userId,
    items: validItems,
    summary: {
      totalItems: validItems.reduce((sum, i) => sum + i.quantity, 0),
      totalGST: parseFloat(totalGST.toFixed(2)),
      grandTotal: parseFloat(grandTotal.toFixed(2))
    }
  };
}

module.exports = { addToCart, updateCartItem, removeFromCart, buildCartResponse };
