const { getCustomer, saveCustomer } = require('../data/customers');
const { createZohoContact } = require('./zohoService');

async function syncCustomer(firebaseUid, phone, name) {
  const existing = getCustomer(firebaseUid);
  if (existing) return existing;

  const zohoContact = await createZohoContact({ phone, name });

  const customer = {
    userId: firebaseUid,
    phone,
    name: name || '',
    zoho_contact_id: zohoContact.contact_id,
    addresses: [],
    createdAt: new Date().toISOString()
  };

  return saveCustomer(customer);
}

module.exports = { syncCustomer };
