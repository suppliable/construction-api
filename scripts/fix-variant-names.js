/**
 * fix-variant-names.js
 *
 * Fixes item names for all variant items in Zoho where the name does not
 * match the pattern "{group_name}-{attribute_value}".
 *
 * This happens when the original import assigned names positionally instead
 * of by attribute value, causing e.g. "Anchor Roma Gi Metal Box-6M" to have
 * attribute Size = "16M" (the 16M variant was placed at position 5 by Zoho).
 *
 * No Excel file needed — derives the correct name from Zoho's own attribute data.
 *
 * Usage:
 *   node scripts/fix-variant-names.js [--dry-run]
 */

const axios = require('axios');
require('dotenv').config();

const DRY_RUN  = process.argv.includes('--dry-run');
const ORG_ID   = process.env.ZOHO_ORG_ID;
const API_BASE = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';

// ── Token ────────────────────────────────
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

async function zohoGet(token, path) {
  const res = await axios.get(`${API_BASE}${path}`, {
    headers: headers(token),
    params: { organization_id: ORG_ID },
  });
  return res.data;
}

async function zohoPut(token, path, body) {
  const res = await axios.put(`${API_BASE}${path}`, body, {
    headers: headers(token),
    params: { organization_id: ORG_ID },
  });
  return res.data;
}

// ── Fetch all Zoho item groups (paginated) ─
async function fetchAllGroups(token) {
  let page = 1, all = [];
  while (true) {
    const res = await axios.get(`${API_BASE}/inventory/v1/itemgroups`, {
      headers: headers(token),
      params: { organization_id: ORG_ID, page, per_page: 200 },
    });
    const groups = res.data.itemgroups || [];
    all = all.concat(groups);
    if (!res.data.page_context?.has_more_page) break;
    page++;
  }
  return all;
}

// ── Fix names for one group (two-pass to avoid conflicts) ─
async function fixGroupNames(token, zohoGroup) {
  const groupId   = zohoGroup.group_id;
  const groupName = zohoGroup.group_name;

  const detail    = await zohoGet(token, `/inventory/v1/itemgroups/${groupId}`);
  const zohoItems = detail.item_group?.items || [];

  // Build list of items that need renaming
  const toFix = [];
  let skipped = 0;

  for (const zohoItem of zohoItems) {
    const attrValue = (
      zohoItem.attributes?.[0]?.option ||
      zohoItem.attribute_option_name1 ||
      ''
    ).trim();

    if (!attrValue) {
      console.log(`    ⚠️  No attribute value for item ${zohoItem.item_id} — skipping`);
      skipped++;
      continue;
    }

    const correctName = `${groupName}-${attrValue}`;
    const currentName = (zohoItem.name || '').trim();

    if (currentName === correctName) {
      skipped++;
      continue;
    }

    console.log(`    ✏️  ${attrValue}: "${currentName}" → "${correctName}"`);
    toFix.push({ item_id: zohoItem.item_id, correctName, attrValue });
  }

  if (toFix.length === 0) return { fixed: 0, skipped, failed: 0 };

  let fixed = 0, failed = 0;

  if (!DRY_RUN) {
    // Pass 1 — rename to temp names to clear all conflicts
    for (const item of toFix) {
      const tempName = `${item.correctName}__TEMP`;
      const putData = await zohoPut(token, `/inventory/v1/items/${item.item_id}`, { name: tempName });
      if (putData.code !== 0)
        console.log(`    ❌ Temp rename failed for ${item.attrValue}: ${putData.message}`);
      await new Promise(r => setTimeout(r, 200));
    }

    // Pass 2 — rename from temp to correct names
    for (const item of toFix) {
      const putData = await zohoPut(token, `/inventory/v1/items/${item.item_id}`, { name: item.correctName });
      if (putData.code !== 0) {
        console.log(`    ❌ Final rename failed for ${item.attrValue}: ${putData.message}`);
        failed++;
      } else {
        fixed++;
      }
      await new Promise(r => setTimeout(r, 200));
    }
  } else {
    fixed = toFix.length;
  }

  return { fixed, skipped, failed };
}

// ── Main ──────────────────────────────────
async function main() {
  if (DRY_RUN) console.log('MODE: DRY RUN — no changes will be written');
  console.log();

  const token = await getToken();
  console.log('Token fetched ✅');

  console.log('Fetching all Zoho item groups...');
  const allGroups = await fetchAllGroups(token);
  console.log(`Found ${allGroups.length} item groups`);
  console.log();

  let totalFixed = 0, totalSkipped = 0, totalFailed = 0;

  for (const group of allGroups) {
    console.log(`[${group.group_name}]`);
    try {
      const result = await fixGroupNames(token, group);
      totalFixed   += result.fixed;
      totalSkipped += result.skipped;
      totalFailed  += result.failed;
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error(`  ❌ Error: ${err.message}`);
      if (err.response?.data) console.error('  Zoho:', JSON.stringify(err.response.data));
    }
  }

  console.log('═'.repeat(50));
  if (DRY_RUN) {
    console.log(`DRY RUN complete — ${totalFixed} names would be corrected`);
  } else {
    console.log('Fix complete:');
    console.log(`  ✅ Names fixed:   ${totalFixed}`);
    console.log(`  ✓  Already correct: ${totalSkipped}`);
    console.log(`  ❌ Failed:          ${totalFailed}`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
