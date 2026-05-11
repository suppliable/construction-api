'use strict';

const redis = require('./redis');
const env = require('../config/env');
const { createSpan } = require('../utils/spanTracer');

const prefix = `${env.appEnv}:`;

function cacheFor(ttlSeconds, keyFn) {
  return async (req, res, next) => {
    const key = prefix + keyFn(req);

    const span = createSpan(null, 'cache.get', { 'cache.key': key, 'cache.ttl_seconds': ttlSeconds });
    try {
      const cached = await redis.get(key);
      if (cached !== null) {
        span.end({ success: true, 'cache.result': 'hit' });
        return res.json(cached);
      }
      span.end({ success: true, 'cache.result': 'miss' });
    } catch (err) {
      span.end({ success: false, error: err });
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 200) {
        const setSpan = createSpan(null, 'cache.set', { 'cache.key': key, 'cache.ttl_seconds': ttlSeconds });
        redis.set(key, body, { ex: ttlSeconds })
          .then(() => setSpan.end({ success: true }))
          .catch((err) => setSpan.end({ success: false, error: err }));
      }
      return originalJson(body);
    };
    next();
  };
}

module.exports = { cacheFor };
