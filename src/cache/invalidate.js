'use strict';

const redis = require('./redis');
const env = require('../config/env');
const { createSpan } = require('../utils/spanTracer');

const prefix = `${env.appEnv}:`;

async function delPattern(pattern) {
  let cursor = 0;
  let totalDeleted = 0;
  do {
    const [next, keys] = await redis.scan(cursor, { match: pattern, count: 100 });
    if (keys.length) {
      await redis.del(...keys);
      totalDeleted += keys.length;
    }
    cursor = parseInt(next);
  } while (cursor !== 0);
  return totalDeleted;
}

async function delKey(key) {
  await redis.del(key);
}

async function withInvalidateSpan(name, attrs, fn) {
  const span = createSpan(null, name, attrs);
  try {
    const keysDeleted = await fn();
    span.end({ success: true, 'cache.keys_deleted': keysDeleted ?? 1 });
  } catch (err) {
    span.end({ success: false, error: err });
    throw err;
  }
}

async function invalidateProducts() {
  await withInvalidateSpan('cache.invalidate.products', { 'cache.scope': 'products,home,search,categories' }, async () => {
    const counts = await Promise.all([
      delPattern(`${prefix}products:*`),
      delKey(`${prefix}home:data`).then(() => 1),
      delPattern(`${prefix}search:*`),
      delPattern(`${prefix}categories:*`),
    ]);
    return counts.reduce((a, b) => a + b, 0);
  });
}

async function invalidateOrder(orderId) {
  await withInvalidateSpan('cache.invalidate.order', { 'cache.key': `${prefix}orders:detail:${orderId}` }, async () => {
    await delKey(`${prefix}orders:detail:${orderId}`);
  });
}

async function invalidateDriverOrders(driverId) {
  await withInvalidateSpan('cache.invalidate.driver_orders', { 'cache.pattern': `${prefix}driver:orders:today:${driverId}:*` }, () =>
    delPattern(`${prefix}driver:orders:today:${driverId}:*`),
  );
}

async function invalidateDriverProfile(driverId) {
  await withInvalidateSpan('cache.invalidate.driver_profile', { 'cache.key': `${prefix}driver:profile:${driverId}` }, async () => {
    await delKey(`${prefix}driver:profile:${driverId}`);
  });
}

async function invalidateConfig(key) {
  await withInvalidateSpan('cache.invalidate.config', { 'cache.key': `${prefix}config:${key}` }, async () => {
    await delKey(`${prefix}config:${key}`);
  });
}

async function invalidateDeliveryConfig() {
  await withInvalidateSpan('cache.invalidate.delivery_config', { 'cache.key': `${prefix}delivery:config` }, async () => {
    await delKey(`${prefix}delivery:config`);
  });
}

module.exports = {
  invalidateProducts,
  invalidateOrder,
  invalidateDriverOrders,
  invalidateDriverProfile,
  invalidateConfig,
  invalidateDeliveryConfig,
};
