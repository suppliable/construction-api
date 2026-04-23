'use strict';

const admin = require('../utils/firebaseAdmin');
const logger = require('../utils/logger');

const CACHE_TTL_MS = 5 * 60 * 1000;

let cache = {
  params: null,
  fetchedAt: 0,
};

// Stored so concurrent cache-miss callers await the same in-flight fetch instead of each firing a separate getTemplate() call
let inflight = null;

async function fetchTemplate() {
  const now = Date.now();
  if (cache.params && now - cache.fetchedAt < CACHE_TTL_MS) return cache.params;

  if (!inflight) {
    inflight = admin.remoteConfig().getTemplate()
      .then(template => {
        cache = { params: template.parameters || {}, fetchedAt: Date.now() };
        return cache.params;
      })
      .catch(err => {
        logger.error({ err: err.message }, 'Failed to fetch Remote Config template');
        if (!cache.params) {
          cache = { params: {}, fetchedAt: Date.now() };
        } else {
          cache.fetchedAt = Date.now(); // extend stale cache to avoid hammering on repeated failures
        }
        return cache.params;
      })
      .finally(() => { inflight = null; });
  }

  return inflight;
}

async function getString(key, defaultValue = '') {
  const params = await fetchTemplate();
  return params[key]?.defaultValue?.value ?? defaultValue;
}

async function getNumber(key, defaultValue = 0) {
  const raw = await getString(key, String(defaultValue));
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

async function getBoolean(key, defaultValue = false) {
  const raw = await getString(key, String(defaultValue));
  return raw === 'true';
}

module.exports = { getString, getNumber, getBoolean };
