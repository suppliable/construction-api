const fetch = (...args) => import('node-fetch').then(({default:f})=>f(...args));
const BASE = 'https://construction-api-2.onrender.com';
const ADMIN_TOKEN = 'suppliable-admin-2024';

(async () => {
  // Get recent orders with address info
  const ordersRes = await fetch(`${BASE}/api/admin/orders`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }
  });
  const ordersData = await ordersRes.json();
  const orders = ordersData.data?.orders || [];
  console.log(`Total orders: ${orders.length}`);

  // Get first 3 orders with addressId
  const testOrders = orders.filter(o => o.addressId).slice(0, 3);

  if (testOrders.length === 0) {
    console.log('No orders with addressId found');
    return;
  }

  // Also fetch current delivery config
  const configRes = await fetch(`${BASE}/api/delivery/config`);
  const configData = await configRes.json();
  console.log('\n── Delivery Config ──');
  console.log(JSON.stringify(configData.data?.config || {}, null, 2));

  for (const order of testOrders) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Order:    ${order.orderId}`);
    console.log(`Customer: ${order.customer?.name || '—'}`);
    console.log(`UserId:   ${order.userId}`);
    console.log(`AddrId:   ${order.addressId}`);
    console.log(`Amount:   ₹${order.grandTotal || order.grand_total || 0}`);
    console.log(`Stored delivery_charge: ₹${order.delivery_charge ?? order.deliveryCharge ?? '—'}`);

    // Test delivery charge calculation
    const delivRes = await fetch(`${BASE}/api/delivery/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: order.userId, addressId: order.addressId })
    });
    const delivData = await delivRes.json();

    if (delivData.success) {
      const d = delivData.data;
      console.log(`\nCalculated:`);
      console.log(`  deliveryCharge:  ₹${d.deliveryCharge}`);
      console.log(`  distanceKm:      ${d.distanceKm} km`);
      console.log(`  distanceText:    ${d.distanceText || '(haversine)'}`);
      console.log(`  distanceSource:  ${d.distanceSource}`);
      console.log(`  serviceable:     ${d.serviceable}`);
    } else {
      console.log(`\nFailed: [${delivData.error}] ${delivData.message}`);
    }
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log('Done.');
})();
