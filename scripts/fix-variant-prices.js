/**
 * fix-variant-prices.js
 *
 * Repairs variant data (rate, stock, purchase_rate, reorder_level, custom_fields)
 * on already-imported Zoho item groups where Zoho's internal ordering may have
 * assigned prices/stocks to the wrong variant.
 *
 * Strategy:
 *   1. Read Excel — build a map of product name → [variant rows]
 *   2. Fetch all item groups from Zoho (paginated)
 *   3. For each group whose name matches an Excel product:
 *        GET /itemgroups/{group_id}  — fetch actual variant IDs + attribute values
 *        Match each Zoho variant to the correct Excel row by attribute value
 *        PUT /items/{item_id}        — write correct rate, stock, etc.
 *   4. Print before/after for every variant changed
 *
 * Usage:
 *   node scripts/fix-variant-prices.js [excel-file] [--dry-run]
 */

const axios = require('axios');
const XLSX  = require('xlsx');
require('dotenv').config();

const EXCEL_FILE = process.argv[2] || './scripts/products-mvp.xlsx';
const DRY_RUN    = process.argv.includes('--dry-run');
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

// ── Zoho API helpers ─────────────────────
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

// ── Read Excel ────────────────────────────
function readExcel(filePath) {
  const wb  = XLSX.readFile(filePath);
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  const headerIdx = raw.findIndex(r => r && r[0] === 'Item Name');
  if (headerIdx === -1) throw new Error('Header row not found');

  const dataRows = raw
    .slice(headerIdx + 3)
    .filter(r => r && r[0] && String(r[0]).trim().length > 0);

  const rows = dataRows.map(r => ({
    item_name:      String(r[0]).trim(),
    gst_pct:        r[3] ? Number(r[3]) : 18,
    has_variants:   r[6] ? String(r[6]).trim().toUpperCase() : 'NO',
    variant_value:  r[8] ? String(r[8]).trim() : '',
    rate_incl_gst:  r[9] ? Number(r[9]) : 0,
    purchase_price: r[10] ? Number(r[10]) : null,
    opening_stock:  r[11] != null ? Math.round(Number(r[11])) : 0,
    reorder_level:  r[12] != null ? Math.round(Number(r[12])) : null,
    rack_number:    r[13] ? String(r[13]).trim() : '',
    featured:       r[14] ? String(r[14]).trim().toUpperCase() === 'YES' : false,
    brand_flag:     r[5] ? String(r[5]).trim().toLowerCase().includes('asian paints') : false,
  }));

  // Group by item_name, keep only variant products
  const map = new Map();
  for (const row of rows) {
    if (row.has_variants !== 'YES') continue;
    if (!map.has(row.item_name)) map.set(row.item_name, []);
    map.get(row.item_name).push(row);
  }
  return map; // Map<productName, variantRow[]>
}

// ── Helpers ───────────────────────────────
function basePrice(rateInclGst, gstPct) {
  return Math.round((rateInclGst / (1 + gstPct / 100)) * 100) / 100;
}

function buildCustomFields(row) {
  const fields = [{ label: 'Featured', value: row.featured ? 'true' : 'false' }];
  if (row.rack_number) fields.push({ label: 'Rack Number', value: row.rack_number });
  if (row.brand_flag)  fields.push({ label: 'Shade Brand', value: 'asian-paints' });
  return fields;
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

// ── Fix one group ─────────────────────────
async function fixGroup(token, zohoGroup, excelVariants) {
  const groupId   = zohoGroup.group_id;
  const groupName = zohoGroup.group_name;

  // GET full group detail to get variant item_ids + attribute values
  const detail      = await zohoGet(token, `/inventory/v1/itemgroups/${groupId}`);
  const zohoItems   = detail.item_group?.items || [];
  const gst         = excelVariants[0].gst_pct;

  let fixed = 0, mismatched = 0, noMatch = 0;

  for (const zohoItem of zohoItems) {
    const zohoAttr = (
      zohoItem.attributes?.[0]?.option ||
      zohoItem.attribute_option_name1 ||
      ''
    ).trim().toLowerCase();

    const row = excelVariants.find(
      v => v.variant_value.trim().toLowerCase() === zohoAttr
    );

    if (!row) {
      console.log(`    ⚠️  No Excel row for attr "${zohoAttr}" — skipping`);
      noMatch++;
      continue;
    }

    const correctRate = basePrice(row.rate_incl_gst, gst);
    const purchaseRate = row.purchase_price || correctRate;
    const currentRate  = zohoItem.rate || 0;

    const rateOk  = Math.abs(currentRate - correctRate) < 0.02;
    const stockOk = (zohoItem.initial_stock || 0) === row.opening_stock;

    if (rateOk && stockOk) {
      console.log(`    ✓  ${row.variant_value}: ₹${correctRate} stock:${row.opening_stock} (already correct)`);
      continue;
    }

    console.log(`    ${rateOk ? ' ' : '💰'} ${row.variant_value}: rate ${currentRate} → ${correctRate}  stock:${row.opening_stock}`);
    mismatched++;

    if (!DRY_RUN) {
      const updatePayload = {
        rate:               correctRate,
        purchase_rate:      purchaseRate,
        initial_stock:      row.opening_stock,
        initial_stock_rate: purchaseRate,
        custom_fields:      buildCustomFields(row),
      };
      if (row.reorder_level) updatePayload.reorder_level = row.reorder_level;

      const putData = await zohoPut(token, `/inventory/v1/items/${zohoItem.item_id}`, updatePayload);
      if (putData.code !== 0) {
        console.log(`    ❌ PUT failed: ${putData.message}`);
      } else {
        fixed++;
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return { total: zohoItems.length, fixed, mismatched, noMatch };
}

// ── Main ──────────────────────────────────
async function main() {
  console.log('Reading Excel:', EXCEL_FILE);
  const excelMap = readExcel(EXCEL_FILE);
  console.log(`Variant products in Excel: ${excelMap.size}`);
  if (DRY_RUN) console.log('MODE: DRY RUN — no changes will be written');
  console.log();

  const token = await getToken();
  console.log('Token fetched ✅');

  console.log('Fetching all Zoho item groups...');
  const allGroups = await fetchAllGroups(token);
  console.log(`Found ${allGroups.length} item groups in Zoho`);
  console.log();

  // Only process groups that exist in our Excel
  const toFix = allGroups.filter(g => excelMap.has(g.group_name));
  console.log(`Groups to check/fix: ${toFix.length}`);
  console.log();

  let totalFixed = 0, totalMismatched = 0, totalNoMatch = 0;

  for (const group of toFix) {
    const excelVariants = excelMap.get(group.group_name);
    console.log(`[${group.group_name}] — ${excelVariants.length} Excel variants`);

    try {
      const result = await fixGroup(token, group, excelVariants);
      totalFixed      += result.fixed;
      totalMismatched += result.mismatched;
      totalNoMatch    += result.noMatch;
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`  ❌ Error: ${err.message}`);
      if (err.response?.data) console.error('  Zoho:', JSON.stringify(err.response.data));
    }
    console.log();
  }

  console.log('═'.repeat(50));
  if (DRY_RUN) {
    console.log(`DRY RUN complete — ${totalMismatched} variants would be updated`);
  } else {
    console.log(`Fix complete:`);
    console.log(`  ✅ Fixed:   ${totalFixed} variants`);
    console.log(`  ⚠️  No match: ${totalNoMatch} variants`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
