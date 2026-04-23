const { getCustomer, saveCustomer, getCustomerByPhone } = require('../services/firestoreService');
const { toCustomerDTO } = require('../models/customerDTO');

async function getCustomerHandler(req, res) {
  const customer = await getCustomer(req.params.userId, req.traceContext);
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }
  const dto = toCustomerDTO(customer);
  res.json({ success: true, data: { customer: dto }, customer: dto, user: dto });
}

async function updateDeliveryAddress(req, res) {
  const customer = await getCustomer(req.params.userId, req.traceContext);
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }

  const { lat, lng, address_line1, address_line2, city, state, pincode, label } = req.body;
  customer.delivery_address = { lat, lng, address_line1, address_line2, city, state, pincode, label };
  await saveCustomer(customer, req.traceContext);

  res.json({ success: true, user: customer });
}

async function updateRegisteredAddress(req, res) {
  const customer = await getCustomer(req.params.userId, req.traceContext);
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }

  if (!customer.is_business) {
    return res.status(400).json({ success: false, message: 'Only business customers can have a registered address' });
  }

  const { address_line1, address_line2, city, state, state_code, pincode } = req.body;
  customer.registered_address = { address_line1, address_line2, city, state, state_code, pincode };
  await saveCustomer(customer, req.traceContext);

  res.json({ success: true, user: customer });
}

async function listCustomers(req, res) {
  res.status(501).json({ success: false, message: 'List all customers not supported with Firestore yet' });
}

async function getCustomerByPhoneHandler(req, res) {
  const customer = await getCustomerByPhone(req.params.phone, req.traceContext);
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }
  res.json({ success: true, user: toCustomerDTO(customer) });
}

module.exports = { getCustomer: getCustomerHandler, updateDeliveryAddress, updateRegisteredAddress, listCustomers, getCustomerByPhone: getCustomerByPhoneHandler };
