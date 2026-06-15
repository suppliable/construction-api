'use strict';

/**
 * Reads rack numbers from the Excel file and updates matching items
 * in Zoho Inventory via the custom field.
 *
 * Usage:
 *   node scripts/upload-rack-numbers.js [--dry-run]
 *
 * Update .env with production Zoho credentials before running.
 */

require('dotenv').config();
const axios = require('axios');
const XLSX = require('xlsx');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const EXCEL_PATH = path.join(process.env.HOME, 'Downloads', 'App Item List Rack (2).xlsx');
const ORG_ID = process.env.ZOHO_ORG_ID;
const API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
const RACK_FIELD_LABEL = 'Rack Number'; // adjust if the field label differs in Zoho

// ── Auth ──────────────────────────────────────────────────────────────────────

let _token = null;
let _tokenExpiry = 0;

async function getAccessToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;
  const res = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: {
      grant_type: 'refresh_token',
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    },
    timeout: 15000,
  });
  _token = res.data.access_token;
  _tokenExpiry = Date.now() + 55 * 60 * 1000;
  return _token;
}

function authHeaders(token) {
  return { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' };
}

// ── Fetch all items from Zoho (paginated) ─────────────────────────────────────

async function fetchAllZohoItems() {
  const items = [];
  let page = 1;
  while (true) {
    const token = await getAccessToken();
    const res = await axios.get(`${API_DOMAIN}/inventory/v1/items`, {
      headers: authHeaders(token),
      params: { organization_id: ORG_ID, page, per_page: 200 },
      timeout: 30000,
    });
    const batch = (res.data.items || []).filter(i => i.status !== 'inactive');
    items.push(...batch);
    const info = res.data.page_context;
    if (!info?.has_more_page) break;
    page++;
    await sleep(300); // be gentle on the API
  }
  return items;
}

// ── Update a single item's rack number ───────────────────────────────────────

async function updateRack(itemId, rackNumber) {
  const token = await getAccessToken();
  const res = await axios.put(
    `${API_DOMAIN}/inventory/v1/items/${itemId}`,
    { custom_fields: [{ label: RACK_FIELD_LABEL, value: rackNumber }] },
    { headers: authHeaders(token), params: { organization_id: ORG_ID }, timeout: 15000 }
  );
  return res.data;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalise(name) {
  return (name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`Org: ${ORG_ID}  Domain: ${API_DOMAIN}\n`);

  // 1. Read Excel — all rows are data (header row is first item)
  const wb = XLSX.readFile(EXCEL_PATH);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }).filter(r => r[0] && r[1]);
  console.log(`Excel rows loaded: ${rows.length}`);

  const excelMap = new Map(); // normalised name → rack
  for (const [name, rack] of rows) {
    excelMap.set(normalise(name), String(rack).trim());
  }

  // 2. Fetch all Zoho items
  console.log('Fetching all items from Zoho...');
  const zohoItems = await fetchAllZohoItems();
  console.log(`Zoho items fetched: ${zohoItems.length}\n`);

  // 3. Discover the rack custom field label from first item that has custom_fields
  const sample = zohoItems.find(i => i.custom_fields?.length);
  if (sample) {
    console.log('Custom field labels on sample item:');
    sample.custom_fields.forEach(f => console.log(`  "${f.label}" = "${f.value}"`));
    console.log();
  }

  // 4. Match and update
  let matched = 0, updated = 0, notFound = 0, failed = 0;
  const unmatched = [];

  for (const item of zohoItems) {
    const rack = excelMap.get(normalise(item.name));
    if (!rack) {
      // not in excel list — skip
      continue;
    }

    matched++;
    const existingRack = item.custom_fields?.find(f => f.label === RACK_FIELD_LABEL)?.value;

    if (existingRack === rack) {
      console.log(`  SKIP  ${item.name} — already "${rack}"`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`  DRY   ${item.name} → "${rack}" (was "${existingRack || 'unset'}")`);
      updated++;
      continue;
    }

    try {
      await updateRack(item.item_id, rack);
      console.log(`  OK    ${item.name} → "${rack}"`);
      updated++;
    } catch (err) {
      console.error(`  FAIL  ${item.name} — ${err.response?.data?.message || err.message}`);
      failed++;
    }

    await sleep(250); // ~4 req/s — well within Zoho's rate limit
  }

  // 5. Report unmatched Excel rows (items in Excel not found in Zoho)
  for (const [normName, rack] of excelMap) {
    const found = zohoItems.some(i => normalise(i.name) === normName);
    if (!found) unmatched.push({ name: normName, rack });
  }

  console.log('\n──────────── Summary ────────────');
  console.log(`Excel rows:       ${rows.length}`);
  console.log(`Zoho items:       ${zohoItems.length}`);
  console.log(`Matched:          ${matched}`);
  console.log(`Updated:          ${updated}`);
  console.log(`Failed:           ${failed}`);
  console.log(`Not in Zoho:      ${unmatched.length}`);

  if (unmatched.length) {
    console.log('\nItems in Excel not found in Zoho (check names):');
    unmatched.forEach(u => console.log(`  "${u.name}" → rack ${u.rack}`));
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
