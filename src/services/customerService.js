const { getCustomer, saveCustomer } = require('../data/customers');
const { createZohoContact } = require('./zohoService');

async function syncCustomer(firebaseUid, phone, name, is_business, business_name, gstin, registered_address) {
  const existing = getCustomer(firebaseUid);
  if (existing) return existing;

  const zohoContact = await createZohoContact({ phone, name, is_business, business_name, gstin, registered_address });

  return saveCustomer({
    userId: firebaseUid,
    phone,
    name: name || '',
    is_business: is_business || false,
    business_name: business_name || '',
    gstin: gstin || '',
    zoho_contact_id: zohoContact.contact_id,
    delivery_address: null,
    registered_address: registered_address || null
  });
}

module.exports = { syncCustomer };
