const BASE = 'https://construction-api-2.onrender.com';
const fetch = (...args) => import('node-fetch').then(({default:f})=>f(...args));
const TEST_USER = 'firestore-prod-003';
const results = [];
const pass = (msg) => { results.push(`✅ ${msg}`); console.log(`✅ ${msg}`); };
const fail = (msg) => { results.push(`❌ ${msg}`); console.log(`❌ ${msg}`); };
const warn = (msg) => { results.push(`⚠️  ${msg}`); console.log(`⚠️  ${msg}`); };

const get = (url) => fetch(url).then(r=>r.json());
const post = (url, body) => fetch(url, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
const put = (url, body) => fetch(url, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
const del = (url, body) => fetch(url, {method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());

(async () => {
  console.log('\n━━━ TESTING ORIGINAL PRE-ORDER ENDPOINTS ━━━\n');

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PRODUCTS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n[ PRODUCTS ]');

  const prods = await get(`${BASE}/api/products`);
  const products = prods.data || prods.products || [];
  products.length > 0 ? pass(`GET /api/products → ${products.length} products`) : fail(`GET /api/products → empty`);

  const p = products[0];
  p?.id ? pass(`Product has id field`) : fail(`Product missing id`);
  p?.name ? pass(`Product has name field`) : fail(`Product missing name`);
  p?.category ? pass(`Product has category field`) : fail(`Product missing category`);
  p?.hasVariants !== undefined ? pass(`Product has hasVariants field`) : fail(`Product missing hasVariants`);
  typeof p?.gst_percentage === 'number' ? pass(`Product has gst_percentage: ${p.gst_percentage}`) : warn(`Product gst_percentage: ${p?.gst_percentage} (check field name)`);

  if (p?.hasVariants && p?.variants?.length > 0) {
    const v = p.variants[0];
    v?.id && v?.name && v?.price !== undefined ? pass(`Variant has id, name, price`) : fail(`Variant missing fields: ${JSON.stringify(v)}`);
  }

  const steelProds = await get(`${BASE}/api/products?category=Steel`);
  (steelProds.data || steelProds.products || []).length > 0 ? pass(`GET /api/products?category=Steel → works`) : warn(`GET /api/products?category=Steel → no results (check category name)`);

  const singleProd = await get(`${BASE}/api/products/${p?.id}`);
  (singleProd.data || singleProd.product || singleProd)?.id ? pass(`GET /api/products/:id → works`) : fail(`GET /api/products/:id → failed: ${JSON.stringify(singleProd)}`);

  const cache = await post(`${BASE}/api/products/cache/clear`, {});
  cache.success ? pass(`POST /api/products/cache/clear → works`) : fail(`Cache clear failed`);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // HOME
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n[ HOME ]');

  const home = await get(`${BASE}/api/home`);
  const homeData = home.data || home;
  homeData?.categories?.length > 0 ? pass(`GET /api/home → categories: ${JSON.stringify(homeData.categories)}`) : fail(`GET /api/home → no categories: ${JSON.stringify(homeData)}`);

  const homeProds = homeData?.featuredProducts || homeData?.products || [];
  homeProds.length > 0 ? pass(`GET /api/home → ${homeProds.length} products`) : fail(`GET /api/home → no products`);
  homeProds[0]?.imageUrl || homeProds[0]?.image ? pass(`Home products have images`) : warn(`Home products missing imageUrl`);

  const cats = await get(`${BASE}/api/home/categories`);
  (cats.data || cats.categories || cats)?.length > 0 ? pass(`GET /api/home/categories → works`) : warn(`GET /api/home/categories → ${JSON.stringify(cats)}`);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // AUTH
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n[ AUTH ]');

  const authPing = await post(`${BASE}/api/auth`, {
    firebaseUid: TEST_USER,
    phone: '9400055555'
  });
  authPing.success ? pass(`POST /api/auth (existing user ping) → works`) : fail(`POST /api/auth → ${JSON.stringify(authPing)}`);

  const customer = authPing.data?.customer || authPing.customer;
  customer?.userId ? pass(`Auth returns customer.userId`) : fail(`Auth missing customer: ${JSON.stringify(authPing.data)}`);
  customer?.name ? pass(`Auth returns customer.name: ${customer.name}`) : warn(`Auth customer missing name`);
  customer?.phone ? pass(`Auth returns customer.phone`) : warn(`Auth customer missing phone`);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // CUSTOMERS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n[ CUSTOMERS ]');

  const custGet = await get(`${BASE}/api/customers/${TEST_USER}`);
  const cust = custGet.data?.customer || custGet.customer || custGet;
  cust?.userId || cust?.name ? pass(`GET /api/customers/:userId → works: ${cust?.name}`) : fail(`GET /api/customers/:userId → ${JSON.stringify(custGet)}`);
  cust?.zoho_contact_id ? pass(`Customer has zoho_contact_id`) : warn(`Customer missing zoho_contact_id`);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ADDRESSES
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n[ ADDRESSES ]');

  const addrList = await get(`${BASE}/api/address/${TEST_USER}`);
  const addrs = addrList.data?.addresses || addrList.addresses || [];
  addrs.length > 0 ? pass(`GET /api/address/:userId → ${addrs.length} addresses`) : warn(`GET /api/address/:userId → no addresses`);

  const addr = addrs[0];
  if (addr) {
    addr?.addressId ? pass(`Address has addressId`) : fail(`Address missing addressId`);
    addr?.label ? pass(`Address has label: ${addr.label}`) : warn(`Address missing label`);
    addr?.flatNo !== undefined ? pass(`Address has flatNo`) : warn(`Address missing flatNo`);
    addr?.streetAddress ? pass(`Address has streetAddress`) : warn(`Address missing streetAddress`);
    addr?.city ? pass(`Address has city`) : warn(`Address missing city`);
    addr?.pincode ? pass(`Address has pincode`) : warn(`Address missing pincode`);
    addr?.latitude !== undefined ? pass(`Address has latitude: ${addr.latitude}`) : warn(`Address missing latitude`);
    addr?.isDefault !== undefined ? pass(`Address has isDefault: ${addr.isDefault}`) : warn(`Address missing isDefault`);
  }

  const addrAdd = await post(`${BASE}/api/address/add`, {
    userId: TEST_USER,
    label: 'Test Site',
    flatNo: '1A',
    buildingName: 'Test Block',
    streetAddress: 'OMR Road',
    city: 'Chennai',
    state: 'Tamil Nadu',
    pincode: '600096',
    isDefault: false
  });
  const newAddrId = addrAdd.data?.addressId || addrAdd.data?.address?.addressId;
  addrAdd.success && newAddrId ? pass(`POST /api/address/add → addressId: ${newAddrId}`) : fail(`POST /api/address/add → ${JSON.stringify(addrAdd)}`);

  if (newAddrId) {
    const addrUpdate = await put(`${BASE}/api/address/update`, {
      userId: TEST_USER,
      addressId: newAddrId,
      label: 'Updated Site'
    });
    addrUpdate.success ? pass(`PUT /api/address/update → works`) : fail(`PUT /api/address/update → ${JSON.stringify(addrUpdate)}`);
  }

  if (addr?.addressId) {
    const addrDefault = await put(`${BASE}/api/address/default`, {
      userId: TEST_USER,
      addressId: addr.addressId
    });
    addrDefault.success ? pass(`PUT /api/address/default → works`) : fail(`PUT /api/address/default → ${JSON.stringify(addrDefault)}`);
  }

  if (newAddrId) {
    const addrDel = await del(`${BASE}/api/address/remove`, {
      userId: TEST_USER,
      addressId: newAddrId
    });
    addrDel.success ? pass(`DELETE /api/address/remove → works`) : fail(`DELETE /api/address/remove → ${JSON.stringify(addrDel)}`);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // CART
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n[ CART ]');

  const cartGet = await get(`${BASE}/api/cart/${TEST_USER}`);
  const cart = cartGet.data?.cart || cartGet.cart || cartGet;
  cartGet.success ? pass(`GET /api/cart/:userId → works`) : fail(`GET /api/cart/:userId → ${JSON.stringify(cartGet)}`);

  const hasNewShape = cart?.subtotal !== undefined && cart?.grandTotal !== undefined;
  const hasOldShape = cart?.summary?.grandTotal !== undefined;
  hasNewShape ? pass(`Cart has subtotal/gstTotal/grandTotal (new shape)`) : fail(`Cart missing new shape fields`);
  hasOldShape ? pass(`Cart has summary.grandTotal (old shape)`) : warn(`Cart missing summary object — frontend may need update if using summary.grandTotal`);

  if (cart?.items?.length > 0) {
    const item = cart.items[0];
    item?.productId ? pass(`Cart item has productId`) : fail(`Cart item missing productId`);
    item?.quantity ? pass(`Cart item has quantity: ${item.quantity}`) : fail(`Cart item missing quantity`);
    item?.unitPrice !== undefined ? pass(`Cart item has unitPrice`) : fail(`Cart item missing unitPrice`);
    item?.totalWithoutGST !== undefined ? pass(`Cart item has totalWithoutGST`) : warn(`Cart item missing totalWithoutGST — check if frontend uses this`);
    item?.gstAmount !== undefined ? pass(`Cart item has gstAmount`) : warn(`Cart item missing gstAmount`);
    item?.grandTotal !== undefined ? pass(`Cart item has grandTotal (item level)`) : warn(`Cart item missing grandTotal`);
  }

  const inStockProduct = products.find(p => p.hasVariants ? p.variants?.some(v=>v.available_stock>0) : p.available_stock>0);
  const testProductId = inStockProduct?.hasVariants ? inStockProduct.variants.find(v=>v.available_stock>0)?.id : inStockProduct?.id;

  if (testProductId) {
    const cartAdd = await post(`${BASE}/api/cart/add`, {
      userId: TEST_USER,
      productId: testProductId,
      quantity: 1
    });
    cartAdd.success ? pass(`POST /api/cart/add → works`) : fail(`POST /api/cart/add → ${cartAdd.error}: ${cartAdd.message}`);

    const cartUpdate = await put(`${BASE}/api/cart/update`, {
      userId: TEST_USER,
      productId: testProductId,
      quantity: 2
    });
    cartUpdate.success ? pass(`PUT /api/cart/update → works`) : fail(`PUT /api/cart/update → ${cartUpdate.error}: ${cartUpdate.message}`);

    const cartRemove = await del(`${BASE}/api/cart/remove`, {
      userId: TEST_USER,
      productId: testProductId
    });
    cartRemove.success ? pass(`DELETE /api/cart/remove → works`) : fail(`DELETE /api/cart/remove → ${cartRemove.error}: ${cartRemove.message}`);
  } else {
    warn(`Skipping cart add/update/remove — no in-stock product found`);
  }

  const cartVal = await get(`${BASE}/api/cart/${TEST_USER}/validate`);
  cartVal.success ? pass(`GET /api/cart/:userId/validate → works`) : fail(`GET /api/cart/:userId/validate → ${JSON.stringify(cartVal)}`);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // UPLOAD
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n[ UPLOAD ]');
  const uploadCheck = await fetch(`${BASE}/api/upload`, { method: 'POST' });
  uploadCheck.status !== 404 ? pass(`POST /api/upload → endpoint exists (status: ${uploadCheck.status})`) : fail(`POST /api/upload → 404 not found`);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SUMMARY
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const passed = results.filter(r=>r.startsWith('✅')).length;
  const failed_count = results.filter(r=>r.startsWith('❌')).length;
  const warned = results.filter(r=>r.startsWith('⚠️')).length;

  console.log(`\n${'━'.repeat(50)}`);
  console.log(`RESULTS: ${passed} passed | ${failed_count} failed | ${warned} warnings`);
  console.log(`${'━'.repeat(50)}`);

  if (failed_count > 0) {
    console.log('\n❌ FAILURES:');
    results.filter(r=>r.startsWith('❌')).forEach(r=>console.log(r));
  }
  if (warned > 0) {
    console.log('\n⚠️  WARNINGS (may affect frontend):');
    results.filter(r=>r.startsWith('⚠️')).forEach(r=>console.log(r));
  }
})();
