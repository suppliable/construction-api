'use strict';

require('dotenv').config();
const axios = require('axios');

const ORG_ID = process.env.ZOHO_ORG_ID;
const API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';

// Replicates the getAccessToken logic from zohoService.js
let accessToken = null;
let tokenExpiry = null;

async function getAccessToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) return accessToken;
  const res = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: {
      grant_type: 'refresh_token',
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    },
  });
  accessToken = res.data.access_token;
  tokenExpiry = Date.now() + 55 * 60 * 1000;
  return accessToken;
}

function headers() {
  return { Authorization: `Zoho-oauthtoken ${accessToken}`, 'Content-Type': 'application/json' };
}

function printCustomFields(label, customFields) {
  console.log(`\n--- ${label} custom_fields ---`);
  if (!customFields || customFields.length === 0) {
    console.log('  (none)');
    return;
  }
  customFields.forEach(f => {
    console.log(JSON.stringify({ label: f.label, api_name: f.api_name, value: f.value, value_formatted: f.value_formatted }));
  });
}

async function main() {
  const itemName = process.argv[2];
  if (!itemName) {
    console.error('Usage: node scripts/debug-custom-fields.js "Item Name Here"');
    process.exit(1);
  }

  await getAccessToken();
  const h = headers();

  // ── Step 1: search by name ───────────────────────────────────────────────
  console.log(`\nSearching for: "${itemName}"`);
  const searchRes = await axios.get(`${API_DOMAIN}/inventory/v1/items`, {
    headers: h,
    params: { organization_id: ORG_ID, name: itemName },
  });

  const matchedItems = searchRes.data.items || [];
  console.log(`Found ${matchedItems.length} item(s) matching the name`);

  if (!matchedItems.length) {
    console.log('No items found. Try a partial name or check spelling.');
    return;
  }

  // ── Step 2: for each matched item, show its custom_fields ───────────────
  for (const item of matchedItems) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Item:      ${item.name}`);
    console.log(`item_id:   ${item.item_id}`);
    console.log(`group_id:  ${item.group_id}`);
    console.log(`group_name:${item.group_name}`);

    // ── Step 3: GET full item detail ─────────────────────────────────────
    const itemDetailRes = await axios.get(`${API_DOMAIN}/inventory/v1/items/${item.item_id}`, {
      headers: h,
      params: { organization_id: ORG_ID },
    });
    const fullItem = itemDetailRes.data.item;
    printCustomFields(`ITEM "${fullItem.name}" (item_id: ${fullItem.item_id})`, fullItem.custom_fields);

    // ── Step 4: GET item group to see all variants and their custom_fields ─
    if (item.group_id) {
      const groupRes = await axios.get(`${API_DOMAIN}/inventory/v1/itemgroups/${item.group_id}`, {
        headers: h,
        params: { organization_id: ORG_ID },
      });
      const grp = groupRes.data.item_group;
      console.log(`\n--- GROUP "${grp.group_name}" (group_id: ${grp.group_id}) ---`);
      console.log(`Group description: ${grp.description ? grp.description.slice(0, 80) + '...' : '(empty)'}`);
      printCustomFields(`GROUP "${grp.group_name}"`, grp.custom_fields);

      const variants = grp.items || [];
      console.log(`\nVariants in group: ${variants.length}`);
      for (const v of variants) {
        console.log(`\n  Variant: ${v.name} (item_id: ${v.item_id})`);
        if (v.custom_fields && v.custom_fields.length) {
          v.custom_fields.forEach(f => {
            console.log('  ' + JSON.stringify({ label: f.label, api_name: f.api_name, value: f.value, value_formatted: f.value_formatted }));
          });
        } else {
          console.log('  custom_fields: (none on variant level)');
        }
      }
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err.response?.data || err.message);
  process.exit(1);
});
