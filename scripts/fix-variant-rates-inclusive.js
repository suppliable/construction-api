/**
 * fix-variant-rates-inclusive.js
 *
 * The import script stored GST-exclusive (base) prices in Zoho's rate field.
 * The app expects GST-inclusive prices in that field (original behaviour).
 *
 * This script reads the rate_incl_gst column from Excel and PUTs it directly
 * as the rate in Zoho for every variant and single item.
 *
 * Usage:
 *   node scripts/fix-variant-rates-inclusive.js [excel-file] [--dry-run]
 */

const axios = require('axios');
const XLSX  = require('xlsx');
require('dotenv').config();

const EXCEL_FILE = process.argv[2] || './scripts/products-mvp.xlsx';
const DRY_RUN    = process.argv.includes('--dry-run');
const START_ROW  = (() => { const a = process.argv.find(x => x.startsWith('--start-row=')); return a ? parseInt(a.split('=')[1]) : null; })();
const ORG_ID     = process.env.ZOHO_ORG_ID;
const API_BASE   = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';

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

async function zohoPut(token, path, body, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.put(`${API_BASE}${path}`, body, {
        headers: headers(token),
        params: { organization_id: ORG_ID },
      });
      return res.data;
    } catch (err) {
      if (err.response?.status === 429 && attempt < retries) {
        const wait = 60000 * (attempt + 1); // 60s, 120s, 180s
        console.log(`    ⏳ Rate limited — waiting ${wait / 1000}s before retry ${attempt + 1}/${retries}...`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
}

// ── Read Excel ────────────────────────────
function readExcel(filePath) {
  const wb  = XLSX.readFile(filePath);
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  const headerIdx = raw.findIndex(r => r && r[0] === 'Item Name');
  if (headerIdx === -1) throw new Error('Header row not found');

  const dataStart = START_ROW ? Math.max(0, START_ROW - (headerIdx + 4)) : 0;
  const dataRows = raw
    .slice(headerIdx + 3 + dataStart)
    .filter(r => r && r[0] && String(r[0]).trim().length > 0);

  const rows = dataRows.map(r => ({
    item_name:      String(r[0]).trim(),
    has_variants:   r[6] ? String(r[6]).trim().toUpperCase() : 'NO',
    variant_value:  r[8] ? String(r[8]).trim() : '',
    rate_incl_gst:  r[9] ? Number(r[9]) : 0,   // ← store this directly
    purchase_price: r[10] ? Number(r[10]) : null,
  }));

  // Map for variant products: name → [rows]
  const variantMap = new Map();
  // Map for single products: name → row
  const singleMap  = new Map();

  for (const row of rows) {
    if (row.has_variants === 'YES') {
      if (!variantMap.has(row.item_name)) variantMap.set(row.item_name, []);
      variantMap.get(row.item_name).push(row);
    } else {
      if (!singleMap.has(row.item_name)) singleMap.set(row.item_name, row);
    }
  }

  return { variantMap, singleMap };
}

// ── Fetch all item groups (paginated) ────
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

// ── Fetch all single items (paginated) ───
async function fetchAllItems(token) {
  let page = 1, all = [];
  while (true) {
    const res = await axios.get(`${API_BASE}/inventory/v1/items`, {
      headers: headers(token),
      params: { organization_id: ORG_ID, page, per_page: 200 },
    });
    const items = res.data.items || [];
    all = all.concat(items);
    if (!res.data.page_context?.has_more_page) break;
    page++;
  }
  return all;
}

// ── Fix rates for one variant group ──────
async function fixGroup(token, zohoGroup, excelVariants) {
  const groupId = zohoGroup.group_id;
  const detail  = await zohoGet(token, `/inventory/v1/itemgroups/${groupId}`);
  const items   = detail.item_group?.items || [];
  const taxId   = detail.item_group?.tax_id;

  let fixed = 0, skipped = 0, noMatch = 0;

  for (const zohoItem of items) {
    const zohoAttr = (
      zohoItem.attributes?.[0]?.option ||
      zohoItem.attribute_option_name1 ||
      ''
    ).trim().toLowerCase();

    const row = excelVariants.find(v => v.variant_value.trim().toLowerCase() === zohoAttr);
    if (!row) {
      console.log(`    ⚠️  No Excel row for "${zohoAttr}" — skipping`);
      noMatch++;
      continue;
    }

    const currentRate = zohoItem.rate || 0;
    const targetRate  = row.rate_incl_gst;
    const rateOk      = Math.abs(currentRate - targetRate) < 0.02;

    if (rateOk) {
      console.log(`    ✓  ${row.variant_value}: ₹${targetRate} (rate ok, fixing tax)`);
    } else {
      console.log(`    💰 ${row.variant_value}: ₹${currentRate} → ₹${targetRate}`);
    }

    if (!DRY_RUN) {
      const putPayload = {
        rate:          targetRate,
        purchase_rate: row.purchase_price || targetRate,
        is_taxable:    true,
      };
      if (taxId) putPayload.tax_id = taxId;
      const putData = await zohoPut(token, `/inventory/v1/items/${zohoItem.item_id}`, putPayload);
      if (putData.code !== 0) {
        console.log(`    ❌ PUT failed: ${putData.message}`);
      } else {
        fixed++;
      }
      await new Promise(r => setTimeout(r, 250));
    } else {
      fixed++;
    }
  }

  return { fixed, skipped, noMatch };
}

// ── Main ──────────────────────────────────
async function main() {
  console.log('Reading Excel:', EXCEL_FILE);
  const { variantMap, singleMap } = readExcel(EXCEL_FILE);
  console.log(`Variant products: ${variantMap.size}  Single products: ${singleMap.size}`);
  if (DRY_RUN) console.log('MODE: DRY RUN — no changes will be written');
  console.log();

  const token = await getToken();
  console.log('Token fetched ✅');

  // ── Variant groups ──
  console.log('Fetching Zoho item groups...');
  const allGroups = await fetchAllGroups(token);
  const groupsToFix = allGroups.filter(g => variantMap.has(g.group_name));
  console.log(`Groups to update: ${groupsToFix.length}`);
  console.log();

  let totalFixed = 0, totalSkipped = 0, totalNoMatch = 0;

  for (const group of groupsToFix) {
    const excelVariants = variantMap.get(group.group_name);
    console.log(`[${group.group_name}]`);
    try {
      const r = await fixGroup(token, group, excelVariants);
      totalFixed   += r.fixed;
      totalSkipped += r.skipped;
      totalNoMatch += r.noMatch;
      await new Promise(r => setTimeout(r, 400));
    } catch (err) {
      console.error(`  ❌ ${err.message}`);
      if (err.response?.data) console.error('  Zoho:', JSON.stringify(err.response.data));
    }
    console.log();
  }

  // ── Single items ──
  console.log('Fetching Zoho single items...');
  const allItems   = await fetchAllItems(token);
  const itemsToFix = allItems.filter(i => singleMap.has(i.name));
  console.log(`Single items to update: ${itemsToFix.length}`);
  console.log();

  let singleFixed = 0;

  for (const zohoItem of itemsToFix) {
    const row = singleMap.get(zohoItem.name);
    const currentRate = zohoItem.rate || 0;
    const targetRate  = row.rate_incl_gst;

    const rateOk = Math.abs(currentRate - targetRate) < 0.02;
    if (rateOk) {
      console.log(`  ✓  ${zohoItem.name}: ₹${targetRate} (rate ok, fixing tax)`);
    } else {
      console.log(`  💰 ${zohoItem.name}: ₹${currentRate} → ₹${targetRate}`);
    }

    if (!DRY_RUN) {
      const putPayload = {
        rate:          targetRate,
        purchase_rate: row.purchase_price || targetRate,
        is_taxable:    true,
      };
      if (zohoItem.tax_id) putPayload.tax_id = zohoItem.tax_id;
      const putData = await zohoPut(token, `/inventory/v1/items/${zohoItem.item_id}`, putPayload);
      if (putData.code !== 0) {
        console.log(`  ❌ PUT failed: ${putData.message}`);
      } else {
        singleFixed++;
      }
      await new Promise(r => setTimeout(r, 250));
    } else {
      singleFixed++;
    }
  }

  console.log('═'.repeat(50));
  if (DRY_RUN) {
    console.log(`DRY RUN — ${totalFixed + singleFixed} rates would be updated`);
  } else {
    console.log('Fix complete:');
    console.log(`  ✅ Variants updated:  ${totalFixed}`);
    console.log(`  ✅ Singles updated:   ${singleFixed}`);
    console.log(`  ✓  Rate unchanged:    ${totalSkipped}`);
    console.log(`  ⚠️  No match:          ${totalNoMatch}`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
