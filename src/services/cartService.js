const { getCart, saveCart } = require('../data/cart');
const { getProductById } = require('./productService');

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
      if (quantity > product.available_stock) {
        const existingItem = cart.items.find(i => i.productId === productId);
        const existingQty = existingItem ? existingItem.quantity : 0;
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
  return await buildCartResponse(userId);
}

async function buildCartResponse(userId) {
  const cart = await getCart(userId);

  let subtotalRaw = 0;
  let gstTotalRaw = 0;

  const items = await Promise.all(cart.items.map(async (item) => {
    const product = await getProductById(item.productId);
    if (!product) return null;

    const totalWithoutGST = parseFloat((product.price * item.quantity).toFixed(2));
    const gstAmount = parseFloat((totalWithoutGST * product.gst_percentage / 100).toFixed(2));
    const itemTotal = parseFloat((totalWithoutGST + gstAmount).toFixed(2));

    subtotalRaw += totalWithoutGST;
    gstTotalRaw += gstAmount;

    return {
      productId: item.productId,
      productName: product.name,
      quantity: item.quantity,
      unitPrice: Number(product.price),
      gstRate: Number(product.gst_percentage),
      itemTotal
    };
  }));

  const validItems = items.filter(Boolean);
  const subtotal = parseFloat(subtotalRaw.toFixed(2));
  const gstTotal = parseFloat(gstTotalRaw.toFixed(2));
  const deliveryCharge = Number(cart.deliveryCharge || 0);
  const grandTotal = parseFloat((subtotal + gstTotal + deliveryCharge).toFixed(2));

  return {
    cart: {
      userId,
      items: validItems,
      subtotal,
      gstTotal,
      deliveryCharge,
      grandTotal
    }
  };
}

async function clearCart(userId) {
  await saveCart(userId, { items: [] });
  return await buildCartResponse(userId);
}

module.exports = { addToCart, updateCartItem, removeFromCart, setDeliveryCharge, buildCartResponse, clearCart };
