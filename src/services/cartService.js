const { randomUUID } = require('crypto');
const { getCart, saveCart } = require('../data/cart');
const { getProductById } = require('./productService');
const { ValidationError, NotFoundError, StockError } = require('../utils/errors');

async function addToCart(userId, productId, quantity, price, shadeInfo = null, variantId = null) {
  if (!price || price <= 0) throw new ValidationError('price is required and must be greater than 0', 'INVALID_PARAM');

  const cart = await getCart(userId);
  const product = await getProductById(productId);
  if (!product) throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');

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
    const existingItem = cart.items.find(i =>
      i.productId === productId &&
      (i.variantId || null) === (resolvedVariantId || null) &&
      (i.shadeCode || null) === (shadeInfo?.shadeCode || null)
    );
    const existingQty = existingItem ? existingItem.quantity : 0;
    const totalRequestedQty = existingQty + quantity;
    if (totalRequestedQty > product.available_stock) {
      const availableToAdd = product.available_stock - existingQty;
      const maxAllowedQty = Math.max(0, product.available_stock);
      throw new StockError(
        availableToAdd <= 0
          ? `Sorry, ${product.name} is out of stock`
          : `Only ${product.available_stock} units available for ${product.name}. You already have ${existingQty} in cart.`,
        [{
          productId,
          productName: product.name,
          requestedQty: totalRequestedQty,
          availableQty: product.available_stock,
          maxAllowedQty,
          existingCartQty: existingQty,
        }]
      );
    }
  }

  // Match on productId + variantId + shadeCode — all three must agree so different sizes of the same shade are separate items
  const existingItem = cart.items.find(item =>
    item.productId === productId &&
    (item.variantId || null) === (resolvedVariantId || null) &&
    (item.shadeCode || null) === (shadeInfo?.shadeCode || null)
  );

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
    if (!product) throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');

    if (product.available_stock !== undefined && product.available_stock !== null) {
      if (quantity > product.available_stock) {
        const existingItem = findItem(cart.items);
        const existingQty = existingItem ? existingItem.quantity : 0;
        const availableToAdd = product.available_stock - existingQty;
        const maxAllowedQty = Math.max(0, product.available_stock);
        throw new StockError(
          availableToAdd <= 0
            ? `Sorry, ${product.name} is out of stock`
            : `Only ${product.available_stock} units available for ${product.name}. You already have ${existingQty} in cart.`,
          [{
            productId,
            productName: product.name,
            requestedQty: quantity,
            availableQty: product.available_stock,
            maxAllowedQty,
            existingCartQty: existingQty,
          }]
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

  const itemResults = await Promise.all(cart.items.map(async (item) => {
    const product = await getProductById(item.productId);
    if (!product) return null;

    const price = item.price;
    if (!price || price <= 0) return null;

    const gstRate = product.gst_percentage || 18;
    const qty = item.quantity;

    // All prices are GST-inclusive — back-calculate base price
    const divisor = 1 + (gstRate / 100);
    const basePrice = Math.round((price / divisor) * 100) / 100;
    const totalWithoutGST = Math.round(basePrice * qty * 100) / 100;
    const gstAmount = Math.round((price * qty - totalWithoutGST) * 100) / 100;
    const itemTotal = Math.round(price * qty * 100) / 100;

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

    return { raw: item, computed: cartItem };
  }));

  const validResults = itemResults.filter(Boolean);
  const validItems = validResults.map(r => r.computed);

  // Persist cleanup: remove stale entries (product removed from Zoho or price invalid)
  if (validResults.length !== cart.items.length) {
    cart.items = validResults.map(r => r.raw);
    saveCart(userId, cart).catch(() => {});
  }
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
