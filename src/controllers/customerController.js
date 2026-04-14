const { getCustomer, saveCustomer } = require('../data/customers');

function getCustomerHandler(req, res) {
  const customer = getCustomer(req.params.userId);
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }
  res.json({ success: true, user: customer });
}

function updateDeliveryAddress(req, res) {
  const customer = getCustomer(req.params.userId);
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }

  const { lat, lng, address_line1, address_line2, city, state, pincode, label } = req.body;
  customer.delivery_address = { lat, lng, address_line1, address_line2, city, state, pincode, label };
  saveCustomer(customer);

  res.json({ success: true, user: customer });
}

function updateRegisteredAddress(req, res) {
  const customer = getCustomer(req.params.userId);
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }

  if (!customer.is_business) {
    return res.status(400).json({ success: false, message: 'Only business customers can have a registered address' });
  }

  const { address_line1, address_line2, city, state, state_code, pincode } = req.body;
  customer.registered_address = { address_line1, address_line2, city, state, state_code, pincode };
  saveCustomer(customer);

  res.json({ success: true, user: customer });
}

module.exports = { getCustomer: getCustomerHandler, updateDeliveryAddress, updateRegisteredAddress };
