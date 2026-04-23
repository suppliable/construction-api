const axios = require('axios');
const { getAccessToken } = require('./zohoService');
const { createSpan } = require('../utils/spanTracer');

async function createZohoSalesOrder(zohoContactId, lineItems, shippingAddress, deliveryCharge, phone, traceContext = null) {
  const span = createSpan(traceContext, 'zoho.api.createSalesOrder', {
    contact_id: zohoContactId,
    line_item_count: lineItems.length,
    endpoint: '/inventory/v1/salesorders'
  });
  try {
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
    span.end({ success: true, salesorder_id: response.data.salesorder?.salesorder_id });
    return response.data.salesorder;
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

async function confirmZohoSalesOrder(salesorder_id, traceContext = null) {
  const span = createSpan(traceContext, 'zoho.api.confirmSalesOrder', {
    salesorder_id,
    endpoint: '/inventory/v1/salesorders/:id/status/open'
  });
  try {
    const token = await getAccessToken();
    const response = await axios.post(
      `${process.env.ZOHO_API_DOMAIN}/inventory/v1/salesorders/${salesorder_id}/status/open`,
      {},
      {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { organization_id: process.env.ZOHO_ORG_ID }
      }
    );
    span.end({ success: true, salesorder_id: response.data.salesorder?.salesorder_id });
    return response.data;
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

async function createZohoInvoiceFromSO(salesorder_id, traceContext = null) {
  const span = createSpan(traceContext, 'zoho.api.createInvoiceFromSO', {
    salesorder_id,
    endpoint: '/inventory/v1/invoices/fromsalesorder'
  });
  try {
    const token = await getAccessToken();
    const response = await axios.post(
      `${process.env.ZOHO_API_DOMAIN}/inventory/v1/invoices/fromsalesorder`,
      {},
      {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { organization_id: process.env.ZOHO_ORG_ID, salesorder_id }
      }
    );
    span.end({ success: true, invoice_id: response.data.invoice?.invoice_id });
    return response.data.invoice;
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

async function updateZohoShipment(salesorder_id, traceContext = null) {
  const span = createSpan(traceContext, 'zoho.api.updateShipment', {
    salesorder_id,
    endpoint: '/inventory/v1/salesorders/:id/shipmentorders'
  });
  try {
    const token = await getAccessToken();
    const response = await axios.post(
      `${process.env.ZOHO_API_DOMAIN}/inventory/v1/salesorders/${salesorder_id}/shipmentorders`,
      {},
      {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { organization_id: process.env.ZOHO_ORG_ID }
      }
    );
    span.end({ success: true, shipment_id: response.data.shipmentorder?.shipment_id });
    return response.data;
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

async function updateZohoSOOrderId(salesorder_id, orderId, traceContext = null) {
  const span = createSpan(traceContext, 'zoho.api.updateSOOrderId', { salesorder_id, endpoint: '/inventory/v1/salesorders/:id' });
  try {
    const token = await getAccessToken();
    await axios.put(
      `${process.env.ZOHO_API_DOMAIN}/inventory/v1/salesorders/${salesorder_id}`,
      { custom_fields: [{ label: 'Suppliable Order ID', value: orderId }] },
      {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { organization_id: process.env.ZOHO_ORG_ID }
      }
    );
    span.end({ success: true, orderId });
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

module.exports = { createZohoSalesOrder, confirmZohoSalesOrder, createZohoInvoiceFromSO, updateZohoShipment, updateZohoSOOrderId };
