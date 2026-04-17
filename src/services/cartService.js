const { getCart, saveCart } = require('../data/cart');
const { getProductById } = require('./productService');
const { calculateItemPrice } = require('../utils/gstCalculator');

async function addToCart(userId, productId, quantity) {
  const cart = await getCart(userId);

  const product = await getProductById(productId);
  if (!product) throw new Error('Product not found');

  if (product.available_stock !== undefined && product.available_stock !== null) {
    const existingItem = cart.items.find(i => i.productId === productId);
    const existingQty = existingItem ? existingItem.quantity : 0;
    const totalRequestedQty = existingQty + quantity;

    if (totalRequestedQty > product.available_stock) {
      const availableToAdd = product.available_stock - existingQty;
      throw new Error(
        availableToAdd <= 0
          ? `Sorry, ${product.name} is out of stock`
          : `Only ${product.available_stock} units available for ${product.name}. You already have ${existingQty} in cart.`
      );
    }
  }

  const existingItem = cart.items.find(i => i.productId === productId);
  if (existingItem) {
    existingItem.quantity += quantity;
  } else {
    cart.items.push({ productId, quantity });
  }

  await saveCart(userId, cart);
  return await buildCartResponse(userId);
}

async function updateCartItem(userId, productId, quantity) {
  const cart = await getCart(userId);

  if (quantity > 0) {
    const product = await getProductById(productId);
    if (!product) throw new Error('Product not found');

    if (product.available_stock !== undefined && product.available_stock !== null) {
      const existingItem = cart.items.find(i => i.productId === productId);
      const existingQty = existingItem ? existingItem.quantity : 0;

      if (quantity > product.available_stock) {
        const availableToAdd = product.available_stock - existingQty;
        throw new Error(
          availableToAdd <= 0
            ? `Sorry, ${product.name} is out of stock`
            : `Only ${product.available_stock} units available for ${product.name}. You already have ${existingQty} in cart.`
        );
      }
    }
  }

  if (quantity <= 0) {
    cart.items = cart.items.filter(i => i.productId !== productId);
  } else {
    const item = cart.items.find(i => i.productId === productId);
    if (!item) throw new Error(`Item ${productId} not in cart`);
    item.quantity = quantity;
  }

  await saveCart(userId, cart);
  return await buildCartResponse(userId);
}

async function removeFromCart(userId, productId) {
  const cart = await getCart(userId);
  cart.items = cart.items.filter(i => i.productId !== productId);
  await saveCart(userId, cart);
  return await buildCartResponse(userId);
}

async function setDeliveryCharge(userId, deliveryCharge, addressId) {
  const cart = await getCart(userId);
  cart.deliveryCharge = deliveryCharge;
  cart.deliveryAddressId = addressId || null;
  await saveCart(userId, cart);
  return { deliveryCharge, deliveryAddressId: cart.deliveryAddressId };
}

async function buildCartResponse(userId) {
  const cart = await getCart(userId);

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
  const deliveryCharge = cart.deliveryCharge || 0;

  return {
    userId,
    items: validItems,
    deliveryCharge,
    deliveryAddressId: cart.deliveryAddressId || null,
    summary: {
      totalItems: validItems.reduce((sum, i) => sum + i.quantity, 0),
      totalWithoutGST,
      totalGST: parseFloat(totalGST.toFixed(2)),
      grandTotal: parseFloat((grandTotal + deliveryCharge).toFixed(2))
    }
  };
}

module.exports = { addToCart, updateCartItem, removeFromCart, setDeliveryCharge, buildCartResponse };
