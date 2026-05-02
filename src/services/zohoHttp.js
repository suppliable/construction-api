'use strict';

const axios = require('axios');
const logger = require('../utils/logger');
const { withRetry, DEFAULT_TIMEOUT_MS } = require('../utils/httpClient');
const { invalidateAfterZohoMutation } = require('../cache/invalidate');
// Lazy require getAccessToken to avoid circularity: zohoService requires this module
// indirectly through any future shared helper. Importing directly is fine today, but
// keeping it lazy keeps the door open.
function getAccessToken() {
  return require('./zohoService').getAccessToken();
}

function buildConfig(token, opts) {
  return {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: process.env.ZOHO_ORG_ID, ...(opts?.params || {}) },
    timeout: opts?.timeout ?? DEFAULT_TIMEOUT_MS,
  };
}

function fireInvalidate(method, url) {
  invalidateAfterZohoMutation(method, url).catch(err => {
    logger.warn({ err: err.message, method, url }, 'cache.invalidate.zoho_mutation.failed');
  });
}

async function zohoGet(url, opts = {}) {
  const token = await getAccessToken();
  const label = opts.label || 'zoho.api.get';
  return withRetry(label, () => axios.get(url, buildConfig(token, opts)));
}

async function zohoPost(url, body = {}, opts = {}) {
  const token = await getAccessToken();
  const res = await axios.post(url, body, buildConfig(token, opts));
  fireInvalidate('POST', url);
  return res;
}

async function zohoPut(url, body = {}, opts = {}) {
  const token = await getAccessToken();
  const res = await axios.put(url, body, buildConfig(token, opts));
  fireInvalidate('PUT', url);
  return res;
}

async function zohoDelete(url, opts = {}) {
  const token = await getAccessToken();
  const res = await axios.delete(url, buildConfig(token, opts));
  fireInvalidate('DELETE', url);
  return res;
}

module.exports = { zohoGet, zohoPost, zohoPut, zohoDelete };
