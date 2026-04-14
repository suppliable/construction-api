const customers = {};

function getCustomer(firebaseUid) {
  return customers[firebaseUid] || null;
}

function saveCustomer(customer) {
  customers[customer.userId] = customer;
  return customer;
}

function getAllCustomers() {
  return Object.values(customers);
}

module.exports = { getCustomer, saveCustomer, getAllCustomers };
