const customers = {};

function getCustomer(firebaseUid) {
  return customers[firebaseUid] || null;
}

function saveCustomer({ userId, phone, name, is_business, business_name, gstin, zoho_contact_id, delivery_address, registered_address }) {
  const customer = {
    userId,
    phone,
    name,
    is_business: is_business || false,
    business_name: business_name || '',
    gstin: gstin || '',
    zoho_contact_id: zoho_contact_id || '',
    delivery_address: delivery_address || null,
    registered_address: registered_address || null,
    createdAt: new Date().toISOString()
  };
  customers[customer.userId] = customer;
  return customer;
}

function getAllCustomers() {
  return Object.values(customers);
}

module.exports = { getCustomer, saveCustomer, getAllCustomers };
