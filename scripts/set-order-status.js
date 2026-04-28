'use strict';
const admin = require('firebase-admin');
const serviceAccount = require('../firebase-service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://suppliable-app-default-rtdb.asia-southeast1.firebasedatabase.app',
  });
}

const [,, orderId, status] = process.argv;

async function main() {
  if (!orderId) {
    // List recent orders with drivers
    const snap = await admin.firestore().collection('orders')
      .orderBy('createdAt', 'desc').limit(10).get();
    snap.forEach(doc => {
      const d = doc.data();
      console.log(doc.id, '| status:', d.status, '| driver:', d.driverId || 'none');
    });
    process.exit(0);
  }
  const ref = admin.firestore().collection('orders').doc(orderId);
  const before = await ref.get();
  const origStatus = before.data()?.status;
  if (status) {
    await ref.update({ status });
    console.log(`${orderId}: ${origStatus} → ${status}`);
  } else {
    console.log(`${orderId}: current status = ${origStatus}`);
  }
  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
