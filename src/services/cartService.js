const { getCart, saveCart } = require('../data/cart');
const { getProductById } = require('./productService');
const { calculateItemPrice } = require('../utils/gstCalculator');

async function addToCart(userId, productId, quantity) {
  const cart = getCart(userId);

  const existingItem = cart.items.find(i => i.productId === productId);
  if (existingItem) {
    existingItem.quantity += quantity;
  } else {
    cart.items.push({ productId, quantity });
  }

  saveCart(userId, cart);
  return await buildCartResponse(userId);
}

async function updateCartItem(userId, productId, quantity) {
  const cart = getCart(userId);

  if (quantity <= 0) {
    cart.items = cart.items.filter(i => i.productId !== productId);
  } else {
    const item = cart.items.find(i => i.productId === productId);
    if (!item) throw new Error(`Item ${productId} not in cart`);
    item.quantity = quantity;
  }

  saveCart(userId, cart);
  return await buildCartResponse(userId);
}

async function removeFromCart(userId, productId) {
  const cart = getCart(userId);
  cart.items = cart.items.filter(i => i.productId !== productId);
  saveCart(userId, cart);
  return await buildCartResponse(userId);
}

async function buildCartResponse(userId) {
  const cart = getCart(userId);

  let grandTotal = 0;
  let totalGST = 0;

  const items = await Promise.all(cart.items.map(async (item) => {
    const product = await getProductById(item.productId);
    if (!product) return null;

    const totalWithoutGST = parseFloat((product.price * item.quantity).toFixed(2));
    const gstAmount = parseFloat((totalWithoutGST * product.gst_percentage / 100).toFixed(2));
    const itemGrandTotal = parseFloat((totalWithoutGST + gstAmount).toFixed(2));

    grandTotal += itemGrandTotal;
    totalGST += gstAmount;

    return {
      productId: item.productId,
      name: product.name,
      quantity: item.quantity,
      unit: product.unit,
      unitPrice: product.price,
      totalWithoutGST,
      gstRate: product.gst_percentage,
      gstAmount,
      grandTotal: itemGrandTotal
    };
  }));

  const validItems = items.filter(Boolean);
  const totalWithoutGST = parseFloat(validItems.reduce((sum, i) => sum + i.totalWithoutGST, 0).toFixed(2));

  return {
    userId,
    items: validItems,
    summary: {
      totalItems: validItems.reduce((sum, i) => sum + i.quantity, 0),
      totalWithoutGST,
      totalGST: parseFloat(totalGST.toFixed(2)),
      grandTotal: parseFloat(grandTotal.toFixed(2))
    }
  };
}

module.exports = { addToCart, updateCartItem, removeFromCart, buildCartResponse };
