/**
 * fix-variant-stock.js
 *
 * Fixes opening stock and reorder level for all variant items in Zoho.
 * Rate fixes are already handled by fix-variant-prices.js.
 *
 * Strategy:
 *   1. Read Excel — build map of product name → [variant rows]
 *   2. Fetch all Zoho item groups (paginated)
 *   3. For each matching group:
 *        GET /itemgroups/{group_id}   — fetch items with current stock
 *        Match each variant by attribute value to Excel row
 *        Calculate stock delta = target - current
 *        POST /inventoryadjustments   — one adjustment per group (stock)
 *        PUT  /items/{item_id}        — reorder_level per variant
 *
 * Usage:
 *   node scripts/fix-variant-stock.js [excel-file] [--dry-run]
 */

const axios = require('axios');
const XLSX  = require('xlsx');
require('dotenv').config();

const EXCEL_FILE = process.argv[2] || './scripts/products-mvp.xlsx';
const DRY_RUN    = process.argv.includes('--dry-run');
const ORG_ID     = process.env.ZOHO_ORG_ID;
const API_BASE   = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';

const TODAY = new Date().toISOString().split('T')[0];

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

async function zohoPost(token, path, body) {
  const res = await axios.post(`${API_BASE}${path}`, body, {
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
  }));

  const map = new Map();
  for (const row of rows) {
    if (row.has_variants !== 'YES') continue;
    if (!map.has(row.item_name)) map.set(row.item_name, []);
    map.get(row.item_name).push(row);
  }
  return map;
}

function basePrice(rateInclGst, gstPct) {
  return Math.round((rateInclGst / (1 + gstPct / 100)) * 100) / 100;
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

// ── Fix stock + reorder for one group ────
async function fixGroup(token, zohoGroup, excelVariants) {
  const groupId = zohoGroup.group_id;
  const gst     = excelVariants[0].gst_pct;

  const detail    = await zohoGet(token, `/inventory/v1/itemgroups/${groupId}`);
  const zohoItems = detail.item_group?.items || [];

  const adjustmentLines = [];
  let reorderFixed = 0, reorderSkipped = 0;
  let noMatch = 0;

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

    // Current stock — Zoho returns stock_on_hand for live items
    const currentStock = zohoItem.stock_on_hand ?? zohoItem.actual_available_stock ?? zohoItem.initial_stock ?? 0;
    const targetStock  = row.opening_stock;
    const delta        = targetStock - currentStock;

    // Current reorder level
    const currentReorder = zohoItem.reorder_level != null ? Math.round(zohoItem.reorder_level) : null;
    const targetReorder  = row.reorder_level;
    const reorderOk      = currentReorder === targetReorder ||
                           (targetReorder == null && (currentReorder == null || currentReorder === 0));

    console.log(`    ${row.variant_value}:`);
    console.log(`      stock:   ${currentStock} → ${targetStock}  (delta: ${delta >= 0 ? '+' : ''}${delta})`);
    console.log(`      reorder: ${currentReorder ?? 'none'} → ${targetReorder ?? 'none'}  ${reorderOk ? '✓' : '⬆'}`);

    if (delta !== 0) {
      const purchaseRate = row.purchase_price || basePrice(row.rate_incl_gst, gst);
      adjustmentLines.push({
        item_id:           zohoItem.item_id,
        quantity_adjusted: delta,
        purchase_rate:     purchaseRate,
      });
    }

    if (!reorderOk && targetReorder != null) {
      if (!DRY_RUN) {
        const putData = await zohoPut(token, `/inventory/v1/items/${zohoItem.item_id}`, {
          reorder_level: targetReorder,
        });
        if (putData.code !== 0) {
          console.log(`      ❌ reorder PUT failed: ${putData.message}`);
        } else {
          reorderFixed++;
        }
        await new Promise(r => setTimeout(r, 250));
      } else {
        reorderFixed++;
      }
    } else {
      reorderSkipped++;
    }
  }

  // POST one inventory adjustment for all stock deltas in this group
  let stockFixed = 0;
  if (adjustmentLines.length > 0) {
    if (!DRY_RUN) {
      const payload = {
        date:        TODAY,
        reason:      'Opening stock correction — variant reassignment',
        description: `Correcting ${zohoGroup.group_name}`,
        line_items:  adjustmentLines,
      };
      const adjData = await zohoPost(token, '/inventory/v1/inventoryadjustments', payload);
      if (adjData.code !== 0) {
        console.log(`    ❌ Adjustment POST failed: ${adjData.message}`);
      } else {
        stockFixed = adjustmentLines.length;
        console.log(`    ✅ Stock adjustment posted (${adjustmentLines.length} variants)`);
      }
      await new Promise(r => setTimeout(r, 500));
    } else {
      console.log(`    [DRY RUN] Would post adjustment for ${adjustmentLines.length} variants`);
      stockFixed = adjustmentLines.length;
    }
  } else {
    console.log(`    ✓  Stock already correct for all variants`);
  }

  return { stockFixed, reorderFixed, noMatch };
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

  const toFix = allGroups.filter(g => excelMap.has(g.group_name));
  console.log(`Groups to process: ${toFix.length}`);
  console.log();

  let totalStock = 0, totalReorder = 0, totalNoMatch = 0;

  for (const group of toFix) {
    const excelVariants = excelMap.get(group.group_name);
    console.log(`[${group.group_name}] — ${excelVariants.length} variants`);

    try {
      const result = await fixGroup(token, group, excelVariants);
      totalStock   += result.stockFixed;
      totalReorder += result.reorderFixed;
      totalNoMatch += result.noMatch;
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`  ❌ Error: ${err.message}`);
      if (err.response?.data) console.error('  Zoho:', JSON.stringify(err.response.data));
    }
    console.log();
  }

  console.log('═'.repeat(50));
  if (DRY_RUN) {
    console.log('DRY RUN complete — no changes written');
    console.log(`  Stock adjustments needed: ${totalStock} variants`);
    console.log(`  Reorder fixes needed:     ${totalReorder} variants`);
  } else {
    console.log('Fix complete:');
    console.log(`  ✅ Stock adjusted:  ${totalStock} variants`);
    console.log(`  ✅ Reorder fixed:   ${totalReorder} variants`);
    console.log(`  ⚠️  No match:        ${totalNoMatch} variants`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
