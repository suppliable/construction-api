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
      address: [
        shippingAddress.flatNo, shippingAddress.buildingName, shippingAddress.streetAddress,
        shippingAddress.city, shippingAddress.state, shippingAddress.pincode
      ].filter(Boolean).join(', ').substring(0, 85)
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

async function confirmZohoSalesOrder(salesorder_id) {
  const token = await getAccessToken();
  const response = await axios.post(
    `${process.env.ZOHO_API_DOMAIN}/inventory/v1/salesorders/${salesorder_id}/status/open`,
    {},
    {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: process.env.ZOHO_ORG_ID }
    }
  );
  return response.data;
}

async function createZohoInvoiceFromSO(salesorder_id) {
  const token = await getAccessToken();
  const response = await axios.post(
    `${process.env.ZOHO_API_DOMAIN}/inventory/v1/invoices/fromsalesorder`,
    {},
    {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: process.env.ZOHO_ORG_ID, salesorder_id }
    }
  );
  return response.data.invoice;
}

async function updateZohoShipment(salesorder_id) {
  const token = await getAccessToken();
  const response = await axios.post(
    `${process.env.ZOHO_API_DOMAIN}/inventory/v1/salesorders/${salesorder_id}/shipmentorders`,
    {},
    {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: process.env.ZOHO_ORG_ID }
    }
  );
  return response.data;
}

module.exports = { createZohoSalesOrder, confirmZohoSalesOrder, createZohoInvoiceFromSO, updateZohoShipment };
