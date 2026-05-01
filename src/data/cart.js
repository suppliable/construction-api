const { getCart: getCartFromFirestore, saveCart: saveCartToFirestore } = require('../services/firestoreService');
const logger = require('../utils/logger');

const cartCache = {};

async function getCart(userId) {
  if (cartCache[userId]) {
    return cartCache[userId];
  }
  const cart = await getCartFromFirestore(userId);

  // Strip items that were saved without a zohoItemId or price — these are
  // incomplete records left by an older code path or a failed add-to-cart.
  if (Array.isArray(cart.items) && cart.items.length) {
    const before = cart.items.length;
    cart.items = cart.items.filter(item =>
      item.zohoItemId && item.price != null && item.price > 0
    );
    if (cart.items.length !== before) {
      const dropped = before - cart.items.length;
      logger.warn({ userId, dropped }, '[Cart] Filtered incomplete items on load');
      // Persist the cleaned cart so zombies don't re-appear after a server restart
      saveCartToFirestore(userId, cart).catch(err =>
        logger.error({ err: err.message, userId }, 'Firestore cart cleanup save error')
      );
    }
  }

  cartCache[userId] = cart;
  return cart;
}

async function saveCart(userId, cart) {
  cartCache[userId] = cart;
  saveCartToFirestore(userId, cart).catch(err =>
    logger.error({ err: err.message, userId }, 'Firestore cart save error')
  );
  return cart;
}

module.exports = { getCart, saveCart };
