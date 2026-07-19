'use strict';

// One-off diagnostic: inspect live Zoho items for the cf_app_visible custom field.
// Self-contained (does NOT load config/env) — needs only ZOHO_* vars from .env.
// Run: node scripts/diag-app-visible.js
require('dotenv').config();
const axios = require('axios');

async function getAccessToken() {
  const res = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: {
      grant_type: 'refresh_token',
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    },
    timeout: 20000,
  });
  return res.data.access_token;
}

async function getItems(token) {
  const all = [];
  let page = 1;
  while (true) {
    const res = await axios.get(`${process.env.ZOHO_API_DOMAIN}/inventory/v1/items`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: process.env.ZOHO_ORG_ID, per_page: 200, page },
      timeout: 20000,
    });
    all.push(...(res.data.items || []).filter(i => i.status !== 'inactive'));
    if (!res.data.page_context?.has_more_page) break;
    page++;
  }
  return all;
}

(async () => {
  console.log('ORG_ID:', process.env.ZOHO_ORG_ID, '| API_DOMAIN:', process.env.ZOHO_API_DOMAIN);
  const token = await getAccessToken();
  const items = await getItems(token);
  console.log(`\nFetched ${items.length} active items`);

  const keySet = new Set();
  let withHash = 0;
  for (const it of items) {
    if (it.custom_field_hash && Object.keys(it.custom_field_hash).length) {
      withHash++;
      Object.keys(it.custom_field_hash).forEach(k => keySet.add(k));
    }
  }
  console.log(`Items with non-empty custom_field_hash: ${withHash}/${items.length}`);
  console.log('Custom-field keys seen:', [...keySet].sort().join(', ') || '(none)');
  console.log('Keys matching /app|visib|walk/:', [...keySet].filter(k => /app|visib|walk/i.test(k)).join(', ') || '(none)');

  const tally = {};
  const hidden = [];
  for (const it of items) {
    const v = it.cf_app_visible ?? it.custom_field_hash?.cf_app_visible;
    const key = JSON.stringify(v);
    tally[key] = (tally[key] || 0) + 1;
    if (v === false || v === 'false') hidden.push(it.name);
  }
  console.log('\ncf_app_visible value distribution:', tally);
  console.log(`Would appear under Walk-in (=false): ${hidden.length}`);
  if (hidden.length) console.log('  ', hidden.slice(0, 20).join(' | '));

  const sample = items.find(i => i.custom_field_hash && Object.keys(i.custom_field_hash).length) || items[0];
  console.log('\nSample (list) custom_field_hash:', JSON.stringify(sample?.custom_field_hash || {}, null, 2));

  // Fetch the SAME item via the detail endpoint to see if custom fields appear there.
  const detailRes = await axios.get(`${process.env.ZOHO_API_DOMAIN}/inventory/v1/items/${sample.item_id}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: process.env.ZOHO_ORG_ID },
    timeout: 20000,
  });
  const d = detailRes.data.item || {};
  console.log(`\nDetail fetch for "${d.name}" (${sample.item_id}):`);
  console.log('  custom_field_hash:', JSON.stringify(d.custom_field_hash || {}, null, 2));
  console.log('  custom_fields:', JSON.stringify(d.custom_fields || [], null, 2));
  console.log('  top-level cf_ keys:', Object.keys(d).filter(k => k.startsWith('cf_')).join(', ') || '(none)');
  process.exit(0);
})().catch(e => { console.error('DIAG ERROR:', e.response?.status, e.response?.data ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
