'use strict';

/**
 * Firestore usage profiling script.
 * Simulates a complete customer → admin → driver → COD order flow
 * and measures exact Firestore reads/writes per scenario.
 *
 * Usage: node scripts/usage-test.js
 * Requires: server running at BASE_URL (node server.js &)
 */

const http = require('http');
const https = require('https');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'suppliable-admin-2024';
const TEST_USER_ID = 'test_profiling_user_001';
const TEST_PHONE = '919999000001';
const TEST_DRIVER_PHONE = '919999000002';

// ── HTTP client ───────────────────────────────────────────────────────────────
function request(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_TOKEN}`,
        'X-User-Id': TEST_USER_ID, // dev bypass for auth middleware
        ...extraHeaders,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, body: data, headers: res.headers });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Request timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

const api = {
  get: (path, headers) => request('GET', path, null, headers),
  post: (path, body, headers) => request('POST', path, body, headers),
  put: (path, body, headers) => request('PUT', path, body, headers),
  delete: (path, headers) => request('DELETE', path, null, headers),
};

// ── Tracker helpers ───────────────────────────────────────────────────────────
async function resetCounters() {
  await api.post('/api/v1/admin/firestore-usage/reset');
}

async function getUsage() {
  const res = await api.get('/api/v1/admin/firestore-usage');
  return res.body.data;
}

function scenarioResult(label, usage) {
  const summary = usage?.summary || { totalReads: 0, totalWrites: 0, totalDeletes: 0 };
  return { label, reads: summary.totalReads, writes: summary.totalWrites, deletes: summary.totalDeletes };
}

// ── Test state ────────────────────────────────────────────────────────────────
let testOrderId = null;
let testAddressId = null;
let testHandoverId = null;
let driverToken = null;
let sampleProductId = null;

// ── Scenario runners ──────────────────────────────────────────────────────────
async function scenario1_browse() {
  console.log('\n▶  S1: Browse products');
  await resetCounters();

  await api.get('/api/v1/home');
  await api.get('/api/v1/products');
  await api.get('/api/v1/search?q=cement');
  await api.get('/api/v1/categories/cement?page=1&limit=20');

  // Grab some product IDs for later
  const productsRes = await api.get('/api/v1/products');
  const products = productsRes.body?.data || productsRes.body || [];
  const productList = Array.isArray(products) ? products : [];
  if (productList.length > 0) sampleProductId = productList[0].id;

  // 5 individual product views
  const ids = productList.slice(0, 5).map(p => p.id).filter(Boolean);
  for (const id of ids) {
    await api.get(`/api/v1/products/${id}`);
  }

  return scenarioResult('S1: Browse products', await getUsage());
}

async function scenario2_cart() {
  console.log('\n▶  S2: Cart operations');
  await resetCounters();

  await api.get(`/api/v1/cart/${TEST_USER_ID}`);

  // Seed the server with a test customer first (syncAuth)
  await api.post('/api/v1/auth', {
    userId: TEST_USER_ID,
    phone: TEST_PHONE,
    name: 'Test Profiling User',
  });

  const productIds = sampleProductId
    ? [sampleProductId]
    : ['test_product_001'];

  // Add 10 items (cycle if few products)
  for (let i = 0; i < 10; i++) {
    await api.post('/api/v1/cart/add', {
      userId: TEST_USER_ID,
      itemId: productIds[i % productIds.length],
      quantity: 1,
      price: 100,
      name: `Test Product ${i}`,
      unit: 'bag',
    });
  }

  // Update 3 quantities
  for (let i = 0; i < 3; i++) {
    await api.put('/api/v1/cart/update', {
      userId: TEST_USER_ID,
      itemId: productIds[i % productIds.length],
      quantity: 2,
    });
  }

  // Remove 1
  await api.delete('/api/v1/cart/remove', {});
  await api.get(`/api/v1/cart/${TEST_USER_ID}/validate`);
  await api.get(`/api/v1/cart/${TEST_USER_ID}`);

  return scenarioResult('S2: Cart operations', await getUsage());
}

async function scenario3_order() {
  console.log('\n▶  S3: Address + order placement');
  await resetCounters();

  await api.get(`/api/v1/addresses/${TEST_USER_ID}`);

  // Add address
  const addrRes = await api.post(`/api/v1/addresses/${TEST_USER_ID}`, {
    label: 'Home',
    name: 'Test User',
    phone: TEST_PHONE,
    addressLine1: '123 Test Street',
    city: 'Chennai',
    state: 'Tamil Nadu',
    pincode: '600001',
    isDefault: true,
  });
  testAddressId = addrRes.body?.data?.addressId || addrRes.body?.addressId;

  if (testAddressId) {
    await api.put(`/api/v1/addresses/${TEST_USER_ID}/${testAddressId}/default`);
  }

  await api.get('/api/v1/config/cod-threshold');
  await api.get(`/api/v1/delivery/charge?pincode=600001`);

  // Place order
  const orderRes = await api.post('/api/v1/orders/create', {
    userId: TEST_USER_ID,
    items: [{
      itemId: sampleProductId || 'test_product_001',
      name: 'Test Product',
      quantity: 2,
      price: 500,
      unit: 'bag',
      gst_percentage: 18,
    }],
    addressId: testAddressId || 'test_addr_001',
    subtotal: 1000,
    gstTotal: 180,
    deliveryCharge: 100,
    total: 1280,
    paymentMode: 'cod',
  });
  testOrderId = orderRes.body?.data?.orderId || orderRes.body?.orderId;

  await api.get(`/api/v1/orders/${TEST_USER_ID}`);
  if (testOrderId) {
    await api.get(`/api/v1/orders/detail/${testOrderId}`);
  }

  return scenarioResult('S3: Address + order placement', await getUsage());
}

async function scenario4_adminProcess() {
  console.log('\n▶  S4: Admin order processing');
  await resetCounters();

  await api.get('/api/v1/admin/orders');
  if (testOrderId) {
    await api.get(`/api/v1/admin/orders/${testOrderId}`);
    await api.post(`/api/v1/admin/orders/${testOrderId}/accept`);
    await api.post(`/api/v1/admin/orders/${testOrderId}/packed`);
    await api.get(`/api/v1/admin/orders/${testOrderId}/picking-list`);

    // Get a vehicle to assign
    const vehiclesRes = await api.get('/api/v1/admin/vehicles');
    const vehicles = vehiclesRes.body?.data || [];
    const vehicleId = vehicles[0]?.vehicleId;

    // Get a driver
    const driversRes = await api.get('/api/v1/admin/drivers');
    const drivers = driversRes.body?.data || [];
    const driverId = drivers[0]?.driverId;

    if (vehicleId && driverId) {
      await api.post(`/api/v1/admin/orders/${testOrderId}/assign-vehicle`, {
        vehicleId,
        driverId,
      });
    }
  }

  return scenarioResult('S4: Admin order processing', await getUsage());
}

async function scenario5_driverDelivery() {
  console.log('\n▶  S5: Driver delivery flow');
  await resetCounters();

  // Driver login
  const authRes = await api.post('/api/v1/driver/auth', { phone: TEST_DRIVER_PHONE, pin: '0000' }, {});
  driverToken = authRes.body?.token || authRes.body?.data?.token;
  const driverHeaders = driverToken ? { Authorization: `Bearer ${driverToken}`, 'X-User-Id': undefined } : {};

  await api.get('/api/v1/driver/orders/today', driverHeaders);

  if (testOrderId) {
    await api.get(`/api/v1/driver/orders/${testOrderId}`, driverHeaders);
    await api.post(`/api/v1/driver/orders/${testOrderId}/loading-complete`, {}, driverHeaders);
    await api.get(`/api/v1/driver/orders/${testOrderId}/eta`, driverHeaders);
    await api.post(`/api/v1/driver/orders/${testOrderId}/arrived`, {}, driverHeaders);
    await api.post(`/api/v1/driver/orders/${testOrderId}/cod-collected`, { amount: 1280 }, driverHeaders);
    await api.post(`/api/v1/driver/orders/${testOrderId}/complete`, {}, driverHeaders);
  }

  await api.get('/api/v1/driver/cod/summary', driverHeaders);

  const handoverRes = await api.post('/api/v1/driver/cod/handover', {
    amount: 1280,
    orderIds: testOrderId ? [testOrderId] : [],
    notes: 'Test handover',
  }, driverHeaders);
  testHandoverId = handoverRes.body?.data?.handoverId || handoverRes.body?.handoverId;

  return scenarioResult('S5: Driver delivery flow', await getUsage());
}

async function scenario6_codReconcile() {
  console.log('\n▶  S6: Admin COD reconciliation');
  await resetCounters();

  await api.get('/api/v1/admin/cod/pending');
  await api.get('/api/v1/admin/cod/handovers');

  if (testHandoverId) {
    await api.post(`/api/v1/admin/cod/confirm-handover/${testHandoverId}`, { notes: 'Confirmed' });
  }

  return scenarioResult('S6: Admin COD reconciliation', await getUsage());
}

// ── Report printer ────────────────────────────────────────────────────────────
function printTable(results) {
  const col1 = 32, col2 = 7, col3 = 8, col4 = 9;

  const line = (c1, c2, c3, c4) =>
    `│ ${c1.padEnd(col1)} │ ${String(c2).padStart(col2 - 1)} │ ${String(c3).padStart(col3 - 1)} │ ${String(c4).padStart(col4 - 1)} │`;

  const divider = (l, m, r) =>
    l + '─'.repeat(col1 + 2) + m + '─'.repeat(col2 + 1) + m + '─'.repeat(col3 + 1) + m + '─'.repeat(col4 + 1) + r;

  console.log('\n' + divider('┌', '┬', '┐'));
  console.log(line('Scenario', 'Reads', 'Writes', 'Deletes'));
  console.log(divider('├', '┼', '┤'));

  let totalReads = 0, totalWrites = 0, totalDeletes = 0;
  for (const r of results) {
    console.log(line(r.label, r.reads, r.writes, r.deletes));
    totalReads += r.reads;
    totalWrites += r.writes;
    totalDeletes += r.deletes;
  }

  console.log(divider('├', '┼', '┤'));
  console.log(line('TOTAL (one complete order)', totalReads, totalWrites, totalDeletes));
  console.log(divider('└', '┴', '┘'));

  // Monthly projection
  const ordersPerDay = 30;
  const daysPerMonth = 30;
  const ordersPerMonth = ordersPerDay * daysPerMonth;
  const readsPerMonth = totalReads * ordersPerMonth;
  const writesPerMonth = totalWrites * ordersPerMonth;

  const FREE_READS_PER_DAY = 50000;
  const FREE_WRITES_PER_DAY = 20000;
  const readsPerDay = totalReads * ordersPerDay;
  const writesPerDay = totalWrites * ordersPerDay;
  const readsStatus = readsPerDay <= FREE_READS_PER_DAY ? '✓ WITHIN FREE TIER' : '✗ EXCEEDS FREE TIER';
  const writesStatus = writesPerDay <= FREE_WRITES_PER_DAY ? '✓ WITHIN FREE TIER' : '✗ EXCEEDS FREE TIER';

  console.log('\n── Monthly projection (' + ordersPerDay + ' orders/day × ' + daysPerMonth + ' days = ' + ordersPerMonth + ' orders/month) ──');
  console.log(`  Total reads/month:   ${readsPerMonth.toLocaleString()}  (${readsPerDay}/day)  ${readsStatus}`);
  console.log(`  Total writes/month:  ${writesPerMonth.toLocaleString()}  (${writesPerDay}/day)  ${writesStatus}`);
  console.log(`  Firestore free tier: ${FREE_READS_PER_DAY.toLocaleString()} reads/day, ${FREE_WRITES_PER_DAY.toLocaleString()} writes/day`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Firestore Usage Profiling — Suppliable API   ');
  console.log('  Target: ' + BASE_URL);
  console.log('═══════════════════════════════════════════════');

  // Verify server is reachable
  try {
    await api.get('/');
  } catch (err) {
    console.error('\n✗ Server not reachable at ' + BASE_URL);
    console.error('  Start it with: node server.js');
    process.exit(1);
  }

  const results = [];

  try { results.push(await scenario1_browse()); } catch (e) { console.error('  S1 error:', e.message); results.push({ label: 'S1: Browse products', reads: 0, writes: 0, deletes: 0 }); }
  try { results.push(await scenario2_cart()); } catch (e) { console.error('  S2 error:', e.message); results.push({ label: 'S2: Cart operations', reads: 0, writes: 0, deletes: 0 }); }
  try { results.push(await scenario3_order()); } catch (e) { console.error('  S3 error:', e.message); results.push({ label: 'S3: Address + order placement', reads: 0, writes: 0, deletes: 0 }); }
  try { results.push(await scenario4_adminProcess()); } catch (e) { console.error('  S4 error:', e.message); results.push({ label: 'S4: Admin order processing', reads: 0, writes: 0, deletes: 0 }); }
  try { results.push(await scenario5_driverDelivery()); } catch (e) { console.error('  S5 error:', e.message); results.push({ label: 'S5: Driver delivery flow', reads: 0, writes: 0, deletes: 0 }); }
  try { results.push(await scenario6_codReconcile()); } catch (e) { console.error('  S6 error:', e.message); results.push({ label: 'S6: Admin COD reconciliation', reads: 0, writes: 0, deletes: 0 }); }

  printTable(results);

  // Full endpoint breakdown
  console.log('\n── Per-endpoint breakdown (all scenarios combined) ──');
  await resetCounters();
  const finalUsage = await getUsage();
  // Note: since we reset at the end, this shows 0 — the breakdowns were captured per-scenario above
  // For full breakdown, user should check server console logs during the run
  console.log('  (See server console for [FIRESTORE] per-request logs)');
  console.log('\nDone.\n');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
