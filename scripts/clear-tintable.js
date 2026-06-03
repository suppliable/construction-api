/**
 * clear-tintable.js
 *
 * Sets cf_tintable = false on every item in Zoho that currently has it set to true.
 *
 * Usage:
 *   node scripts/clear-tintable.js [--dry-run]
 */

const axios = require('axios');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const ORG_ID  = process.env.ZOHO_ORG_ID;
const API_BASE = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';

async function getToken() {
  const res = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: {
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    },
  });
  if (!res.data.access_token)
    throw new Error('Token fetch failed: ' + JSON.stringify(res.data));
  return res.data.access_token;
}

const headers = (token) => ({
  Authorization: `Zoho-oauthtoken ${token}`,
  'Content-Type': 'application/json',
});

async function zohoPut(token, itemId, body, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.put(`${API_BASE}/inventory/v1/items/${itemId}`, body, {
        headers: headers(token),
        params: { organization_id: ORG_ID },
      });
      return res.data;
    } catch (err) {
      if (err.response?.status === 429 && attempt < retries) {
        const wait = 60000 * (attempt + 1);
        console.log(`  ⏳ Rate limited — waiting ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
}

async function fetchAllTintableItems(token) {
  let page = 1, all = [];
  while (true) {
    const res = await axios.get(`${API_BASE}/inventory/v1/items`, {
      headers: headers(token),
      params: { organization_id: ORG_ID, page, per_page: 200 },
    });
    const items = res.data.items || [];
    const tintable = items.filter(i => !!i.cf_tintable);
    all = all.concat(tintable);
    if (!res.data.page_context?.has_more_page) break;
    page++;
  }
  return all;
}

async function main() {
  if (DRY_RUN) console.log('MODE: DRY RUN — no changes will be written\n');

  const token = await getToken();
  console.log('Token fetched ✅');

  console.log('Fetching all items with cf_tintable = true...');
  const items = await fetchAllTintableItems(token);
  console.log(`Found ${items.length} tintable items\n`);

  if (items.length === 0) {
    console.log('Nothing to clear.');
    return;
  }

  let cleared = 0, failed = 0;

  for (const item of items) {
    console.log(`  [${cleared + failed + 1}/${items.length}] ${item.name}`);
    if (DRY_RUN) { cleared++; continue; }

    try {
      const res = await zohoPut(token, item.item_id, {
        custom_fields: [{ label: 'Tintable', value: false }],
      });
      if (res.code !== 0) {
        console.log(`    ❌ Failed: ${res.message}`);
        failed++;
      } else {
        console.log(`    ✅ Cleared`);
        cleared++;
      }
    } catch (err) {
      console.log(`    ❌ Error: ${err.response?.data?.message || err.message}`);
      failed++;
    }

    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\n' + '═'.repeat(50));
  if (DRY_RUN) {
    console.log(`DRY RUN — ${cleared} items would be cleared`);
  } else {
    console.log(`Cleared: ${cleared}`);
    console.log(`Failed:  ${failed}`);
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
