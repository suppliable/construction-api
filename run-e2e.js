const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const BASE = 'https://construction-api-2.onrender.com';
const ADMIN_TOKEN = 'suppliable-admin-2024';
const USER_ID = 'e2e-test-001';
const results = [];
const pass = (msg) => { results.push(`✅ ${msg}`); console.log(`✅ ${msg}`); };
const fail = (msg) => { results.push(`❌ ${msg}`); console.log(`❌ ${msg}`); };
const warn = (msg) => { results.push(`⚠️  ${msg}`); console.log(`⚠️  ${msg}`); };
const req = (url, opts) => fetch(url, opts).then(r=>r.json()).catch(async e => {
  if (e.code === 'ECONNRESET' || e.type === 'system') {
    await new Promise(r => setTimeout(r, 3000));
    return fetch(url, opts).then(r=>r.json()).catch(()=>({ success:false, error:'NETWORK_ERROR', message: e.message }));
  }
  return { success:false, error:'NETWORK_ERROR', message: e.message };
});
const get = (url, token) => req(url, token ? {headers:{Authorization:`Bearer ${token}`}} : {});
const post = (url, body, token) => req(url, {method:'POST', headers:{...(token?{Authorization:`Bearer ${token}`}:{}),'Content-Type':'application/json'}, body:JSON.stringify(body)});
const put = (url, body, token) => req(url, {method:'PUT', headers:{...(token?{Authorization:`Bearer ${token}`}:{}),'Content-Type':'application/json'}, body:JSON.stringify(body)});
const del = (url, token) => req(url, {method:'DELETE', headers:token?{Authorization:`Bearer ${token}`}:{}});

(async () => {
  // Clear cache and cart
  await post(`${BASE}/api/products/cache/clear`, {});
  await del(`${BASE}/api/cart/${USER_ID}`);

  // PHASE 1 — CONFIG
  const ws = await get(`${BASE}/api/config/warehouse-status`);
  ws.success && ws.data?.isOpen !== undefined ? pass(`Warehouse status: isOpen=${ws.data.isOpen}`) : fail(`Warehouse status: ${JSON.stringify(ws)}`);

  const cod = await get(`${BASE}/api/config/cod-threshold`);
  cod.success && cod.data?.cod_threshold === 7500 ? pass(`COD threshold: ${cod.data.cod_threshold}`) : fail(`COD threshold: ${JSON.stringify(cod)}`);

  const auth = await post(`${BASE}/api/admin/auth`, {password:'suppliable123'});
  auth.success && auth.data?.token === ADMIN_TOKEN ? pass(`Admin auth: token returned`) : fail(`Admin auth: ${JSON.stringify(auth)}`);

  // PHASE 2 — PRODUCTS
  const prods = await get(`${BASE}/api/products`);
  const products = prods.data || [];
  let testProductId = null, testProductName = null;
  for (const p of products) {
    if (p.hasVariants) {
      const v = p.variants?.find(v => v.available_stock > 0);
      if (v) { testProductId = v.id; testProductName = `${p.name} ${v.name} (stock:${v.available_stock})`; break; }
    } else if (p.available_stock > 0) {
      testProductId = p.id; testProductName = `${p.name} (stock:${p.available_stock})`; break;
    }
  }
  testProductId ? pass(`Product found: ${testProductName}`) : fail(`No in-stock product found — check Zoho stock`);
  if (!testProductId) { console.log('STOPPING — no product'); return; }

  // PHASE 3 — ADDRESS
  const addrs = await get(`${BASE}/api/addresses/${USER_ID}`);
  const testAddressId = addrs.data?.addresses?.[0]?.addressId;
  testAddressId ? pass(`Address: ${testAddressId}`) : fail(`No address for ${USER_ID}`);
  if (!testAddressId) { console.log('STOPPING — no address'); return; }

  // PHASE 4 — CART
  const cartAdd = await post(`${BASE}/api/cart/add`, {userId:USER_ID, productId:testProductId, quantity:2});
  cartAdd.success ? pass(`Cart add: ₹${cartAdd.data?.cart?.grandTotal}, items:${cartAdd.data?.cart?.items?.length}`) : fail(`Cart add: ${cartAdd.error} — ${cartAdd.message}`);

  const cartGet = await get(`${BASE}/api/cart/${USER_ID}`);
  const cartOk = cartGet.data?.cart && typeof cartGet.data.cart.subtotal === 'number' && typeof cartGet.data.cart.grandTotal === 'number';
  cartOk ? pass(`Cart get: subtotal=₹${cartGet.data.cart.subtotal} grandTotal=₹${cartGet.data.cart.grandTotal}`) : fail(`Cart get: ${JSON.stringify(cartGet)}`);

  const cartVal = await get(`${BASE}/api/cart/${USER_ID}/validate`);
  cartVal.data?.valid ? pass(`Cart validate: valid`) : fail(`Cart validate: ${JSON.stringify(cartVal.data)}`);

  const overStock = await post(`${BASE}/api/cart/add`, {userId:USER_ID, productId:testProductId, quantity:99999});
  !overStock.success && (overStock.error === 'STOCK_ISSUE' || overStock.error === 'INSUFFICIENT_STOCK' || overStock.error === 'OUT_OF_STOCK') ? pass(`Over-stock blocked: ${overStock.error}`) : fail(`Over-stock not blocked: ${JSON.stringify(overStock)}`);

  // PHASE 5 — DELIVERY
  const deliv = await post(`${BASE}/api/delivery/calculate`, {userId:USER_ID, addressId:testAddressId});
  const charge = deliv.data?.deliveryCharge ?? 50;
  deliv.success ? pass(`Delivery: ₹${charge} via ${deliv.data?.distanceSource}`) : warn(`Delivery: ${deliv.error} — using ₹50`);

  const saveCharge = await post(`${BASE}/api/cart/${USER_ID}/delivery-charge`, {deliveryCharge:charge, addressId:testAddressId});
  saveCharge.success ? pass(`Delivery charge saved: ₹${charge}`) : fail(`Save charge: ${saveCharge.error}`);

  const cartAfterCharge = await get(`${BASE}/api/cart/${USER_ID}`);
  cartAfterCharge.data?.cart?.deliveryCharge === charge ? pass(`Cart has delivery charge: ₹${charge}`) : fail(`Cart delivery charge wrong: got ${cartAfterCharge.data?.cart?.deliveryCharge}`);

  // PHASE 6 — WAREHOUSE CLOSE TEST
  const wClose = await put(`${BASE}/api/config/warehouse-status`, {isOpen:false, closedMessage:'E2E test'}, ADMIN_TOKEN);
  wClose.success ? pass(`Warehouse closed`) : fail(`Close warehouse: ${wClose.error}`);

  const blocked = await post(`${BASE}/api/orders/create`, {userId:USER_ID, addressId:testAddressId, paymentType:'COD'});
  blocked.error === 'WAREHOUSE_CLOSED' && blocked.canAddToCart === true ? pass(`Warehouse blocks order, canAddToCart=true`) : fail(`Warehouse block: ${JSON.stringify(blocked)}`);

  const wOpen = await put(`${BASE}/api/config/warehouse-status`, {isOpen:true}, ADMIN_TOKEN);
  wOpen.success ? pass(`Warehouse reopened`) : fail(`Reopen warehouse: ${wOpen.error}`);

  // PHASE 7 — CREATE ORDER
  const order = await post(`${BASE}/api/orders/create`, {userId:USER_ID, addressId:testAddressId, paymentType:'COD'});
  const OID = order.data?.order?.orderId;
  order.success && OID ? pass(`Order created: ${OID}, status:${order.data.order.status}`) : fail(`Order create: ${order.error} — ${order.message}`);
  if (!OID) { console.log('STOPPING — no order'); return; }

  const cartCleared = await get(`${BASE}/api/cart/${USER_ID}`);
  cartCleared.data?.cart?.items?.length === 0 ? pass(`Cart cleared after order`) : fail(`Cart not cleared: ${cartCleared.data?.cart?.items?.length} items`);

  const history = await get(`${BASE}/api/orders/${USER_ID}`);
  history.data?.orders?.find(o => o.orderId === OID) ? pass(`Order in history`) : fail(`Order not in history`);

  const detail = await get(`${BASE}/api/orders/detail/${OID}`);
  detail.data?.order?.statusLabel === 'Order Placed' ? pass(`Customer status: Order Placed`) : fail(`Status label: ${detail.data?.order?.statusLabel}`);

  // PHASE 8 — ADMIN FLOW
  const adminOrders = await get(`${BASE}/api/admin/orders`, ADMIN_TOKEN);
  adminOrders.data?.orders?.find(o => o.orderId === OID) ? pass(`Admin sees order`) : fail(`Admin order missing`);

  const adminDetail = await get(`${BASE}/api/admin/orders/${OID}`, ADMIN_TOKEN);
  const ad = adminDetail.data?.order;
  ad?.items?.length > 0 && ad?.grandTotal > 0 ? pass(`Admin detail: ${ad.items.length} items, ₹${ad.grandTotal}`) : fail(`Admin detail: ${JSON.stringify(adminDetail)}`);

  const accept = await post(`${BASE}/api/admin/orders/${OID}/accept`, {}, ADMIN_TOKEN);
  const otp = accept.data?.order?.deliveryOtp;
  accept.success && accept.data?.order?.zoho_so_number && otp ? pass(`Order accepted: SO=${accept.data.order.zoho_so_number} INV=${accept.data.order.zoho_invoice_number} OTP=${otp}`) : fail(`Accept: ${accept.error} — ${accept.message}`);

  const statusAfterAccept = await get(`${BASE}/api/orders/detail/${OID}`);
  statusAfterAccept.data?.order?.status === 'accepted' && !statusAfterAccept.data?.order?.deliveryOtp ? pass(`Customer: accepted, OTP hidden`) : fail(`After accept: status=${statusAfterAccept.data?.order?.status} otp=${statusAfterAccept.data?.order?.deliveryOtp}`);

  const pick = await get(`${BASE}/api/admin/orders/${OID}/picking-list`, ADMIN_TOKEN);
  pick.success && pick.data?.items?.length > 0 ? pass(`Picking list: ${pick.data.items.length} items, rack:${pick.data.items[0]?.rackNumber}`) : fail(`Picking: ${pick.error}`);

  const pack = await post(`${BASE}/api/admin/orders/${OID}/packed`, {}, ADMIN_TOKEN);
  pack.data?.order?.status === 'ready_for_dispatch' ? pass(`Packed: ready_for_dispatch`) : fail(`Pack: ${pack.error}`);

  const vehs = await get(`${BASE}/api/admin/vehicles`, ADMIN_TOKEN);
  const vehicle = vehs.data?.vehicles?.find(v => v.isAvailable);
  vehicle ? pass(`Vehicle available: ${vehicle.name}`) : fail(`No available vehicles`);

  const drvs = await get(`${BASE}/api/admin/drivers`, ADMIN_TOKEN);
  const driver = drvs.data?.drivers?.find(d => d.isAvailable);
  driver ? pass(`Driver available: ${driver.name}`) : fail(`No available drivers`);

  const assign = await post(`${BASE}/api/admin/orders/${OID}/assign-vehicle`, {vehicleId:vehicle?.vehicleId, driverId:driver?.driverId}, ADMIN_TOKEN);
  assign.data?.order?.status === 'loading' ? pass(`Assigned: ${assign.data.order.driverName} — ${assign.data.order.vehicleName}`) : fail(`Assign: ${assign.error}`);

  const vehAfter = await get(`${BASE}/api/admin/vehicles`, ADMIN_TOKEN);
  !vehAfter.data?.vehicles?.find(v => v.vehicleId === vehicle?.vehicleId)?.isAvailable ? pass(`Vehicle marked unavailable`) : fail(`Vehicle still available`);

  // PHASE 9 — DRIVER FLOW
  const load = await post(`${BASE}/api/driver/orders/${OID}/loading-complete`, {});
  load.data?.order?.status === 'out_for_delivery' ? pass(`Loading complete: out_for_delivery`) : fail(`Load: ${load.error}`);

  const trackOFD = await get(`${BASE}/api/orders/detail/${OID}`);
  trackOFD.data?.order?.statusLabel === 'Out for Delivery' && trackOFD.data?.order?.driverName && !trackOFD.data?.order?.deliveryOtp ? pass(`Customer: Out for Delivery, driver=${trackOFD.data.order.driverName}, OTP hidden`) : fail(`OFD: label=${trackOFD.data?.order?.statusLabel} otp=${trackOFD.data?.order?.deliveryOtp}`);

  const arrived = await post(`${BASE}/api/driver/orders/${OID}/arrived`, {});
  arrived.data?.order?.status === 'arrived' ? pass(`Driver arrived`) : fail(`Arrived: ${arrived.error}`);

  const trackArrived = await get(`${BASE}/api/orders/detail/${OID}`);
  const customerOtp = trackArrived.data?.order?.deliveryOtp;
  customerOtp && customerOtp === otp ? pass(`OTP visible to customer: ${customerOtp}`) : fail(`OTP: got ${customerOtp} expected ${otp}`);

  const codBlock = await post(`${BASE}/api/driver/orders/${OID}/complete`, {otp});
  !codBlock.success ? pass(`Complete blocked without COD collection`) : fail(`Should block before COD`);

  const codCollect = await post(`${BASE}/api/driver/orders/${OID}/cod-collected`, {amount:charge});
  codCollect.success ? pass(`COD collected: ₹${charge}`) : fail(`COD: ${codCollect.error}`);

  const wrongOtp = await post(`${BASE}/api/driver/orders/${OID}/complete`, {otp:'0000'});
  !wrongOtp.success ? pass(`Wrong OTP rejected`) : fail(`Wrong OTP accepted!`);

  const complete = await post(`${BASE}/api/driver/orders/${OID}/complete`, {otp:customerOtp});
  complete.success ? pass(`Order DELIVERED!`) : warn(`Complete: ${complete.error} — ${complete.message} (photo may be required)`);

  // PHASE 10 — POST DELIVERY
  const finalDetail = await get(`${BASE}/api/orders/detail/${OID}`);
  finalDetail.data?.order?.status === 'delivered' ? pass(`Final status: delivered`) : warn(`Final: ${finalDetail.data?.order?.status}`);

  const vehFinal = await get(`${BASE}/api/admin/vehicles`, ADMIN_TOKEN);
  vehFinal.data?.vehicles?.find(v => v.vehicleId === vehicle?.vehicleId)?.isAvailable ? pass(`Vehicle available again`) : fail(`Vehicle still unavailable`);

  const drvFinal = await get(`${BASE}/api/admin/drivers`, ADMIN_TOKEN);
  drvFinal.data?.drivers?.find(d => d.driverId === driver?.driverId)?.isAvailable ? pass(`Driver available again`) : fail(`Driver still unavailable`);

  const pendingCod = await get(`${BASE}/api/admin/cod/pending`, ADMIN_TOKEN);
  pendingCod.data?.orders?.find(o => o.orderId === OID) ? pass(`COD pending reconciliation`) : fail(`Not in COD pending`);

  const recon = await post(`${BASE}/api/admin/cod/${OID}/reconcile`, {amountReceived:charge}, ADMIN_TOKEN);
  recon.success ? pass(`COD reconciled`) : fail(`Reconcile: ${recon.error}`);

  const pendingAfter = await get(`${BASE}/api/admin/cod/pending`, ADMIN_TOKEN);
  !pendingAfter.data?.orders?.find(o => o.orderId === OID) ? pass(`COD removed from pending`) : fail(`Still in pending after reconcile`);

  // SUMMARY
  const passed = results.filter(r => r.startsWith('✅')).length;
  const failed = results.filter(r => r.startsWith('❌')).length;
  const warned = results.filter(r => r.startsWith('⚠️')).length;
  console.log(`\n${'━'.repeat(50)}`);
  console.log(`E2E RESULTS: ${passed} passed | ${failed} failed | ${warned} warnings`);
  console.log(`${'━'.repeat(50)}`);
  if (failed > 0) {
    console.log('\nFAILURES:');
    results.filter(r => r.startsWith('❌')).forEach(r => console.log(r));
  }
})();
