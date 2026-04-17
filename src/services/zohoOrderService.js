const axios = require('axios');
const { getAccessToken } = require('./zohoService');

async function createZohoSalesOrder(zohoContactId, lineItems, shippingAddress, deliveryCharge, phone) {
  const token = await getAccessToken();

  const body = {
    customer_id: zohoContactId,
    line_items: lineItems.map(item => ({
      item_id: item.productId,
      quantity: item.quantity,
      rate: item.unitPrice
    })),
    shipping_charge: deliveryCharge || 0,
    shipping_address: {
      address: shippingAddress.streetAddress.substring(0, 99),
      city: shippingAddress.city,
      state: shippingAddress.state,
      zip: shippingAddress.pincode,
      country: 'India'
    },
    notes: `Suppliable B2B Order${phone ? ` | Phone: ${phone}` : ''}`
  };

  const response = await axios.post(
    `${process.env.ZOHO_API_DOMAIN}/inventory/v1/salesorders`,
    body,
    {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: process.env.ZOHO_ORG_ID }
    }
  );

  return response.data.salesorder;
}

module.exports = { createZohoSalesOrder };
