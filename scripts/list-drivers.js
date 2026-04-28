'use strict';
const admin = require('firebase-admin');
const serviceAccount = require('../firebase-service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://suppliable-app-default-rtdb.asia-southeast1.firebasedatabase.app',
  });
}

admin.firestore().collection('drivers').get().then(snap => {
  snap.forEach(doc => {
    const d = doc.data();
    console.log(doc.id, '| name:', d.name, '| phone:', d.phone, '| active:', d.isActive, '| hasPin:', !!d.pin);
  });
  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
