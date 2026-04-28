const { randomUUID } = require('crypto');
const { getCart, saveCart } = require('../data/cart');
const { getProductById } = require('./productService');

async function addToCart(userId, productId, quantity, shadeInfo = null) {
  const cart = await getCart(userId);

  const product = await getProductById(productId);
  if (!product) throw new Error('Product not found');

  if (product.available_stock !== undefined && product.available_stock !== null) {
    const existingItem = cart.items.find(i => i.productId === productId && i.shadeCode === (shadeInfo?.shadeCode));
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

  // For shaded items, use shadeCode as part of the item key to allow multiple shades of same product
  const existingItem = cart.items.find(i =>
    i.productId === productId && i.shadeCode === (shadeInfo?.shadeCode || undefined)
  );

  if (existingItem) {
    existingItem.quantity += quantity;
    if (shadeInfo?.price != null) existingItem.price = shadeInfo.price;
  } else {
    const newItem = { cartItemId: randomUUID(), productId, quantity };
    if (shadeInfo) {
      if (shadeInfo.shadeCode) newItem.shadeCode = shadeInfo.shadeCode;
      if (shadeInfo.shadeName) newItem.shadeName = shadeInfo.shadeName;
      if (shadeInfo.shadeTier) newItem.shadeTier = shadeInfo.shadeTier;
      if (shadeInfo.price != null) newItem.price = shadeInfo.price;
    }
    cart.items.push(newItem);
  }

  await saveCart(userId, cart);
  return await buildCartResponse(userId);
}

async function updateCartItem(userId, productId, quantity, cartItemId = null) {
  const cart = await getCart(userId);

  const findItem = (items) => cartItemId
    ? items.find(i => i.cartItemId === cartItemId)
    : items.find(i => i.productId === productId);

  if (quantity > 0) {
    const product = await getProductById(productId);
    if (!product) throw new Error('Product not found');

    if (product.available_stock !== undefined && product.available_stock !== null) {
      if (quantity > product.available_stock) {
        const existingItem = findItem(cart.items);
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
    cart.items = cart.items.filter(i => cartItemId ? i.cartItemId !== cartItemId : i.productId !== productId);
  } else {
    const item = findItem(cart.items);
    if (item) {
      item.quantity = quantity;
    } else {
      cart.items.push({ cartItemId: randomUUID(), productId, quantity });
    }
  }

  await saveCart(userId, cart);
  return await buildCartResponse(userId);
}

async function removeFromCart(userId, productId, cartItemId = null) {
  const cart = await getCart(userId);
  cart.items = cart.items.filter(i => cartItemId ? i.cartItemId !== cartItemId : i.productId !== productId);
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

    // Use shade price if set (tier-based pricing), otherwise fall back to Zoho product price
    const unitPrice = item.price != null ? item.price : product.price;
    const totalWithoutGST = parseFloat((unitPrice * item.quantity).toFixed(2));
    const gstAmount = parseFloat((totalWithoutGST * product.gst_percentage / 100).toFixed(2));
    const itemTotal = parseFloat((totalWithoutGST + gstAmount).toFixed(2));

    subtotalRaw += totalWithoutGST;
    gstTotalRaw += gstAmount;

    const cartItem = {
      cartItemId: item.cartItemId || null,
      productId: item.productId,
      name: product.name,
      productName: product.name,
      unit: product.unit || '',
      quantity: item.quantity,
      unitPrice: Number(unitPrice),
      gstRate: Number(product.gst_percentage),
      totalWithoutGST,
      gstAmount,
      itemTotal,
      grandTotal: itemTotal,
    };

    if (item.shadeCode) {
      cartItem.shadeCode = item.shadeCode;
      cartItem.shadeName = item.shadeName || null;
      cartItem.shadeTier = item.shadeTier || null;
    }

    return cartItem;
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
      grandTotal,
      summary: {
        totalWithoutGST: subtotal,
        totalGST: gstTotal,
        grandTotal
      }
    }
  };
}

async function clearCart(userId) {
  await saveCart(userId, { items: [] });
  return await buildCartResponse(userId);
}

module.exports = { addToCart, updateCartItem, removeFromCart, setDeliveryCharge, buildCartResponse, clearCart };
