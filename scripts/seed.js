require('dotenv').config();
const { db } = require('../src/services/firestoreService');

async function seed() {
  const vehicles = [
    { name: 'Tata Ace — TN01AB1234', isAvailable: true },
    { name: 'Tata 407 — TN02CD5678', isAvailable: true }
  ];
  const drivers = [
    { name: 'Ravi Kumar', phone: '9876543210', isActive: true, isAvailable: true },
    { name: 'Suresh M',   phone: '8765432109', isActive: true, isAvailable: true }
  ];

  for (const v of vehicles) {
    const id = 'VH' + Date.now() + Math.floor(Math.random() * 1000);
    await db.collection('vehicles').doc(id).set({ vehicleId: id, ...v });
    console.log('Seeded vehicle:', v.name);
    await new Promise(r => setTimeout(r, 50));
  }

  for (const d of drivers) {
    const id = 'DR' + Date.now() + Math.floor(Math.random() * 1000);
    await db.collection('drivers').doc(id).set({ driverId: id, ...d });
    console.log('Seeded driver:', d.name);
    await new Promise(r => setTimeout(r, 50));
  }

  console.log('Seed complete.');
  process.exit(0);
}

seed().catch(e => { console.error(e); process.exit(1); });
