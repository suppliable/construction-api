'use strict';

const admin = require('../utils/firebaseAdmin');
const logger = require('../utils/logger');

const { CACHE_TTL_MS } = require('../constants');

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

function normalizePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

function parseCsv(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map(value => normalizePhone(value))
    .filter(Boolean);
}

async function getAdminUserPhoneAllowlist() {
  const raw = await getString('admin_user_phones', '');
  return parseCsv(raw);
}

async function isAllowlistedAdminPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  const allowlist = await getAdminUserPhoneAllowlist();
  return allowlist.includes(normalized);
}

module.exports = {
  getString,
  getNumber,
  getBoolean,
  normalizePhone,
  getAdminUserPhoneAllowlist,
  isAllowlistedAdminPhone,
};
