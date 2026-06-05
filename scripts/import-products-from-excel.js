const axios = require('axios');
const XLSX = require('xlsx');
require('dotenv').config();

// ── Config ──────────────────────────────
const EXCEL_FILE = process.argv[2] || './scripts/products.xlsx';
const DRY_RUN = process.argv.includes('--dry-run');
const START_ROW = (() => { const a = process.argv.find(x => x.startsWith('--start-row=')); return a ? parseInt(a.split('=')[1]) : null; })();
const END_ROW   = (() => { const a = process.argv.find(x => x.startsWith('--end-row='));   return a ? parseInt(a.split('=')[1]) : null; })();
const ORG_ID = process.env.ZOHO_ORG_ID;
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

// ── Zoho API helpers ─────────────────────
const zohoHeaders = (token) => ({
  Authorization: `Zoho-oauthtoken ${token}`,
  'Content-Type': 'application/json',
});

async function zohoGet(token, path) {
  const res = await axios.get(`${API_BASE}${path}`, {
    headers: zohoHeaders(token),
    params: { organization_id: ORG_ID },
  });
  return res.data;
}

async function zohoPost(token, path, body) {
  const res = await axios.post(`${API_BASE}${path}`, body, {
    headers: zohoHeaders(token),
    params: { organization_id: ORG_ID },
  });
  return res.data;
}

async function zohoPut(token, path, body) {
  const res = await axios.put(`${API_BASE}${path}`, body, {
    headers: zohoHeaders(token),
    params: { organization_id: ORG_ID },
  });
  return res.data;
}

// ── Read Excel ───────────────────────────
function readExcel(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  const headerIdx = raw.findIndex(r => r && r[0] === 'Item Name');
  if (headerIdx === -1) throw new Error('Header row not found');

  // headerIdx is 0-based; data rows start at spreadsheet row (headerIdx + 4) in 1-based terms
  const dataStart = START_ROW ? Math.max(0, START_ROW - (headerIdx + 4)) : 0;
  // END_ROW is 1-based row number; as a slice end it equals the 0-based exclusive index
  const sliceEnd  = END_ROW ? END_ROW : undefined;
  const dataRows = raw
    .slice(headerIdx + 3 + dataStart, sliceEnd)
    .filter(r => r && r[0] && String(r[0]).trim().length > 0);

  return dataRows.map(r => ({
    item_name:      String(r[0]).trim(),
    category:       r[1] ? String(r[1]).trim() : '',
    hsn_code:       r[2] ? String(Math.round(Number(r[2]))) : '',
    gst_pct:        r[3] ? Number(r[3]) : 18,
    unit:           r[4] ? String(r[4]).trim() : '',
    brand:          r[5] ? String(r[5]).trim() : '',
    has_variants:   r[6] ? String(r[6]).trim().toUpperCase() : 'NO',
    variant_name:   r[7] ? String(r[7]).trim() : 'Size',
    variant_value:  r[8] ? String(r[8]).trim() : '',
    rate_incl_gst:  r[9] ? Number(r[9]) : 0,
    purchase_price: r[10] ? Number(r[10]) : null,
    opening_stock:  r[11] != null ? Math.round(Number(r[11])) : 0,
    reorder_level:  r[12] != null ? Math.round(Number(r[12])) : null,
    rack_number:    r[13] ? String(r[13]).trim() : '',
    featured:       r[14] ? String(r[14]).trim().toUpperCase() === 'YES' : false,
    brand_flag:     r[5] ? String(r[5]).trim().toLowerCase().includes('asian paints') : false,
  }));
}

// ── Group rows by item name ───────────────
function groupByItem(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.item_name)) groups.set(row.item_name, []);
    groups.get(row.item_name).push(row);
  }
  return groups;
}

// ── Base price (GST-exclusive) ────────────
function basePrice(rateInclGst, gstPct) {
  return Math.round((rateInclGst / (1 + gstPct / 100)) * 100) / 100;
}

// ── Build item SKU ────────────────────────
function makeSku(itemName, variantValue) {
  return `${itemName.replace(/[^a-zA-Z0-9]/g, '').substring(0, 30).toUpperCase()}-${variantValue.replace(/\s/g, '')}`;
}

// ── Fetch tax ID map from Zoho ────────────
async function getTaxIdMap(token) {
  const data = await zohoGet(token, '/inventory/v1/settings/taxes');
  const map = {};
  for (const t of data.taxes || []) {
    // Only use intra-state (GST) tax groups, not IGST
    if (t.tax_specification === 'intra') {
      const pct = t.tax_percentage;
      map[pct] = t.tax_id;
    }
  }
  return map; // e.g. { 5: '...', 12: '...', 18: '...', 28: '...' }
}

function resolveTaxId(taxIdMap, gstPct) {
  return taxIdMap[gstPct] || taxIdMap[18];
}

// ── Fetch category map from Zoho ──────────
async function getCategoryMap(token) {
  const data = await zohoGet(token, '/inventory/v1/categories');
  const map = {};
  for (const c of data.categories || []) {
    if (c.name && c.name !== 'ROOT') map[c.name.toLowerCase()] = c.category_id;
  }
  return map;
}

// ── Custom fields builder ─────────────────
function buildCustomFields(row, brandFlag) {
  const fields = [
    { label: 'Featured', value: row.featured ? 'true' : 'false' },
  ];
  if (row.rack_number) fields.push({ label: 'Rack Number', value: row.rack_number });
  if (brandFlag)       fields.push({ label: 'Shade Brand', value: 'asian-paints' });
  return fields;
}

// ── Create item group (with variants) ─────
// Uses POST (group shell) → GET (fetch real variant IDs) →
// match each variant by attribute value → PUT correct data per variant.
// This prevents price/stock mismatch caused by Zoho reordering variants.
async function createItemGroup(token, itemName, rows, catId, taxIdMap) {
  const first    = rows[0];
  const taxId    = resolveTaxId(taxIdMap, first.gst_pct);
  const attrName = first.variant_name || 'Size';

  // Step 1 — POST group shell with attribute options only (no items[])
  const groupPayload = {
    group_name:      itemName,
    unit:            first.unit,
    hsn_or_sac:      first.hsn_code,
    tax_id:          taxId,
    is_taxable:      true,
    attribute_name1: attrName,
    items: rows.map(r => ({
      name:                   `${itemName}-${r.variant_value}`,
      sku:                    makeSku(itemName, r.variant_value),
      unit:                   first.unit,
      rate:                   0, // placeholder — corrected in Step 4
      attribute_option_name1: r.variant_value,
    })),
  };
  if (catId)        groupPayload.category_id = catId;
  if (first.brand)  groupPayload.brand = first.brand;

  if (DRY_RUN) {
    console.log('[DRY RUN] Would create item group:');
    console.log(JSON.stringify(groupPayload, null, 2));
    return { group_id: 'DRY_RUN', group_name: itemName };
  }

  const createData = await zohoPost(token, '/inventory/v1/itemgroups', groupPayload);
  if (createData.code !== 0)
    throw new Error(`Zoho error creating ${itemName}: ${createData.message}`);

  const groupId = createData.item_group.group_id;

  // Step 2 — GET group to read actual variant IDs + attribute assignments
  await new Promise(r => setTimeout(r, 800));
  const fetchData = await zohoGet(token, `/inventory/v1/itemgroups/${groupId}`);
  const createdItems = fetchData.item_group?.items || [];

  // Step 3 & 4 — Match each Zoho variant by attribute value, PUT correct data
  let updated = 0;
  for (const zohoItem of createdItems) {
    const zohoAttr = (
      zohoItem.attributes?.[0]?.option ||
      zohoItem.attribute_option_name1 ||
      ''
    ).trim().toLowerCase();

    const row = rows.find(r => r.variant_value.trim().toLowerCase() === zohoAttr);
    if (!row) {
      console.warn(`  ⚠️  No Excel match for variant: "${zohoItem.attribute_option_name1}"`);
      continue;
    }

    const rate         = row.rate_incl_gst;
    const purchaseRate = row.purchase_price || rate;

    const updatePayload = {
      name:                rate > 0 ? `${itemName}-${row.variant_value}` : zohoItem.name,
      rate,
      purchase_rate:       purchaseRate,
      initial_stock:       row.opening_stock,
      initial_stock_rate:  purchaseRate,
      tax_id:              taxId,
      is_taxable:          true,
      custom_fields:       buildCustomFields(row, first.brand_flag),
    };
    if (row.reorder_level) updatePayload.reorder_level = row.reorder_level;

    const putData = await zohoPut(token, `/inventory/v1/items/${zohoItem.item_id}`, updatePayload);
    if (putData.code !== 0) {
      console.warn(`  ⚠️  PUT failed for ${row.variant_value}: ${putData.message}`);
    } else {
      console.log(`  ✅ ${row.variant_value} → ₹${rate}  stock:${row.opening_stock}`);
      updated++;
    }
    await new Promise(r => setTimeout(r, 300));
  }

  if (updated < createdItems.length)
    console.warn(`  ⚠️  Only ${updated}/${createdItems.length} variants updated`);

  return createData.item_group;
}

// ── Create single item (no variants) ──────
async function createSingleItem(token, itemName, row, catId, taxIdMap) {
  const gst          = row.gst_pct;
  const taxId        = resolveTaxId(taxIdMap, gst);
  const rate         = row.rate_incl_gst;
  const purchaseRate = row.purchase_price || rate;

  const payload = {
    name:               itemName,
    unit:               row.unit,
    hsn_or_sac:         row.hsn_code,
    tax_id:             taxId,
    is_taxable:         true,
    item_type:          'inventory',
    rate:               rate,
    purchase_rate:      purchaseRate,
    initial_stock:      row.opening_stock,
    initial_stock_rate: purchaseRate,
    custom_fields:      buildCustomFields(row, row.brand_flag),
  };
  if (catId)            payload.category_id = catId;
  if (row.brand)        payload.brand = row.brand;
  if (row.reorder_level) payload.reorder_level = row.reorder_level;

  if (DRY_RUN) {
    console.log('[DRY RUN] Would create single item:');
    console.log(JSON.stringify(payload, null, 2));
    return { item_id: 'DRY_RUN', name: itemName };
  }

  const data = await zohoPost(token, '/inventory/v1/items', payload);
  if (data.code !== 0)
    throw new Error(`Zoho error creating ${itemName}: ${data.message}`);
  return data.item;
}

// ── Main ──────────────────────────────────
async function main() {
  console.log('Reading Excel file:', EXCEL_FILE);
  const rows   = readExcel(EXCEL_FILE);
  const groups = groupByItem(rows);

  console.log(`Products to import: ${groups.size}`);
  console.log(`Total rows: ${rows.length}`);
  if (DRY_RUN) console.log('MODE: DRY RUN — nothing will be created');
  console.log();

  const token = await getToken();
  console.log('Zoho token fetched ✅');

  const [categoryMap, taxIdMap] = await Promise.all([
    getCategoryMap(token),
    getTaxIdMap(token),
  ]);
  console.log('Categories loaded:', Object.keys(categoryMap).join(', '));
  console.log('Tax IDs loaded:', JSON.stringify(taxIdMap));
  console.log();

  let created = 0, failed = 0;
  const results = [];

  for (const [itemName, itemRows] of groups) {
    const first       = itemRows[0];
    const hasVariants = first.has_variants === 'YES';
    const catId       = categoryMap[first.category.toLowerCase()] || null;

    try {
      let result;
      if (hasVariants) {
        console.log(`Creating GROUP: ${itemName} (${itemRows.length} variants)...`);
        result = await createItemGroup(token, itemName, itemRows, catId, taxIdMap);
        console.log(`  ✅ Group: ${result.group_name} (ID: ${result.group_id})`);
      } else {
        console.log(`Creating item: ${itemName}...`);
        result = await createSingleItem(token, itemName, first, catId, taxIdMap);
        console.log(`  ✅ Item: ${result.name} (ID: ${result.item_id})`);
      }

      results.push({ name: itemName, status: 'success', id: result.group_id || result.item_id });
      created++;
      await new Promise(r => setTimeout(r, 500));

    } catch (err) {
      console.error(`  ❌ Failed: ${itemName} — ${err.message}`);
      if (err.response?.data) console.error('  Zoho:', JSON.stringify(err.response.data));
      results.push({ name: itemName, status: 'failed', error: err.message });
      failed++;
    }
  }

  console.log();
  console.log('═'.repeat(50));
  console.log(`Import complete:`);
  console.log(`  ✅ Created: ${created}`);
  console.log(`  ❌ Failed:  ${failed}`);
  console.log();
  results.forEach(r => {
    console.log(`  ${r.name}: ${r.status === 'success' ? '✅ ' + r.id : '❌ ' + r.error}`);
  });
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
