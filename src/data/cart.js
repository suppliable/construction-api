const carts = {};

function getCart(userId) {
  if (!carts[userId]) {
    carts[userId] = { items: [] };
  }
  return carts[userId];
}

function saveCart(userId, cart) {
  carts[userId] = cart;
}

module.exports = { getCart, saveCart };
