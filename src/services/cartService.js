const { randomUUID } = require('crypto');
const { getCart, saveCart } = require('../data/cart');
const { getProductById } = require('./productService');

async function addToCart(userId, productId, quantity, price, shadeInfo = null, variantId = null) {
  if (!price || price <= 0) throw new Error('price is required and must be greater than 0');

  const cart = await getCart(userId);
  const product = await getProductById(productId);
  if (!product) throw new Error('Product not found');

  // Resolve variant fields for ALL products (shade or not)
  let resolvedZohoItemId = productId;
  let resolvedVariantId = variantId || null;
  if (variantId && product.variants) {
    const variant = product.variants.find(v => v.name === variantId || v.id === variantId);
    if (variant) {
      resolvedZohoItemId = variant.id;
      resolvedVariantId = variant.name;
    }
  }

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

  // Match existing item on productId + shadeCode (paint) or productId + variantId (variant), or just productId
  const existingItem = cart.items.find(i => {
    if (i.productId !== productId) return false;
    if (shadeInfo?.shadeCode) return i.shadeCode === shadeInfo.shadeCode;
    if (variantId) return i.variantId === variantId;
    return !i.shadeCode && !i.variantId;
  });

  if (existingItem) {
    existingItem.quantity += quantity;
    existingItem.price = price;
  } else {
    const newItem = {
      cartItemId: randomUUID(),
      productId,
      zohoItemId: resolvedZohoItemId,
      variantId: resolvedVariantId,
      price,
      quantity,
    };
    if (shadeInfo) {
      if (shadeInfo.shadeCode) newItem.shadeCode = shadeInfo.shadeCode;
      if (shadeInfo.shadeName) newItem.shadeName = shadeInfo.shadeName;
      if (shadeInfo.shadeTier) newItem.shadeTier = shadeInfo.shadeTier;
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

    const price = item.price;
    const gstRate = product.gst_percentage || 18;
    const qty = item.quantity;

    let basePrice, gstAmount, itemTotal, totalWithoutGST;
    if (item.shadeTier) {
      // Paint: tier price is GST-inclusive — back-calculate base price
      const divisor = 1 + (gstRate / 100);
      basePrice = Math.round((price / divisor) * 100) / 100;
      totalWithoutGST = Math.round(basePrice * qty * 100) / 100;
      gstAmount = Math.round((price * qty - totalWithoutGST) * 100) / 100;
      itemTotal = Math.round(price * qty * 100) / 100;
    } else {
      // Non-paint: price is base excl GST
      basePrice = price;
      totalWithoutGST = Math.round(price * qty * 100) / 100;
      gstAmount = Math.round(price * (gstRate / 100) * qty * 100) / 100;
      itemTotal = Math.round((price + price * (gstRate / 100)) * qty * 100) / 100;
    }

    subtotalRaw += totalWithoutGST;
    gstTotalRaw += gstAmount;

    const cartItem = {
      cartItemId: item.cartItemId || null,
      productId: item.productId,
      zohoItemId: item.zohoItemId || null,
      variantId: item.variantId || null,
      name: product.name,
      productName: product.name,
      unit: product.unit || '',
      quantity: qty,
      price,
      unitPrice: price,
      basePrice,
      gstRate,
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
  const subtotal = Math.round(subtotalRaw * 100) / 100;
  const gstTotal = Math.round(gstTotalRaw * 100) / 100;
  const deliveryCharge = Number(cart.deliveryCharge || 0);
  const grandTotal = Math.round((subtotal + gstTotal + deliveryCharge) * 100) / 100;

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
