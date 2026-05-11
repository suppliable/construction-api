const { createSpan } = require('../utils/spanTracer');
const { zohoPost, zohoPut } = require('./zohoHttp');

async function createZohoSalesOrder(zohoContactId, lineItems, shippingAddress, deliveryCharge, phone, traceContext = null) {
  const span = createSpan(traceContext, 'zoho.api.createSalesOrder', {
    'peer.service': 'zoho',
    contact_id: zohoContactId,
    line_item_count: lineItems.length,
    endpoint: '/inventory/v1/salesorders'
  });
  try {
    const zohoLineItems = lineItems.map(item => {
      const gstRate = item.gstRate || 18;
      const baseRate = Math.round((item.unitPrice / (1 + gstRate / 100)) * 100) / 100;
      return {
        item_id: item.zohoItemId || item.productId,
        name: [
          item.name,
          item.variantId || null,
          item.shadeCode ? `(${item.shadeCode} - ${item.shadeName})` : null,
        ].filter(Boolean).join(' '),
        description: item.shadeCode
          ? `Shade: ${item.shadeCode} - ${item.shadeName || ''} (${item.shadeTier || ''} shade)`
          : '',
        quantity: item.quantity,
        rate: baseRate,
        unit: item.unit,
      };
    });
    console.log('[Zoho SO] Line items being sent:', JSON.stringify(zohoLineItems, null, 2));
    const body = {
      customer_id: zohoContactId,
      line_items: zohoLineItems,
      shipping_charge: deliveryCharge || 0,
      shipping_address: {
        address: [
          shippingAddress.flatNo, shippingAddress.buildingName, shippingAddress.streetAddress,
          shippingAddress.city, shippingAddress.state, shippingAddress.pincode
        ].filter(Boolean).join(', ').substring(0, 85)
      },
      notes: `Suppliable B2B Order${phone ? ` | Phone: ${phone}` : ''}`
    };

    const response = await zohoPost(
      `${process.env.ZOHO_API_DOMAIN}/inventory/v1/salesorders`,
      body
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
    'peer.service': 'zoho',
    salesorder_id,
    endpoint: '/inventory/v1/salesorders/:id/status/open'
  });
  try {
    const response = await zohoPost(
      `${process.env.ZOHO_API_DOMAIN}/inventory/v1/salesorders/${salesorder_id}/status/open`,
      {}
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
    'peer.service': 'zoho',
    salesorder_id,
    endpoint: '/inventory/v1/invoices/fromsalesorder'
  });
  try {
    const response = await zohoPost(
      `${process.env.ZOHO_API_DOMAIN}/inventory/v1/invoices/fromsalesorder`,
      {},
      { params: { salesorder_id } }
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
    'peer.service': 'zoho',
    salesorder_id,
    endpoint: '/inventory/v1/salesorders/:id/shipmentorders'
  });
  try {
    const response = await zohoPost(
      `${process.env.ZOHO_API_DOMAIN}/inventory/v1/salesorders/${salesorder_id}/shipmentorders`,
      {}
    );
    span.end({ success: true, shipment_id: response.data.shipmentorder?.shipment_id });
    return response.data;
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

async function updateZohoSOOrderId(salesorder_id, orderId, traceContext = null) {
  const span = createSpan(traceContext, 'zoho.api.updateSOOrderId', { 'peer.service': 'zoho', salesorder_id, endpoint: '/inventory/v1/salesorders/:id' });
  try {
    await zohoPut(
      `${process.env.ZOHO_API_DOMAIN}/inventory/v1/salesorders/${salesorder_id}`,
      { custom_fields: [{ label: 'Suppliable Order ID', value: orderId }] }
    );
    span.end({ success: true, orderId });
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

async function markZohoInvoiceAsSent(invoiceId, traceContext = null) {
  const span = createSpan(traceContext, 'zoho.api.markInvoiceAsSent', {
    'peer.service': 'zoho',
    invoice_id: invoiceId,
    endpoint: '/inventory/v1/invoices/:id/status/sent'
  });
  try {
    await zohoPost(
      `${process.env.ZOHO_API_DOMAIN}/inventory/v1/invoices/${invoiceId}/status/sent`,
      {}
    );
    span.end({ success: true, invoice_id: invoiceId });
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

module.exports = { createZohoSalesOrder, confirmZohoSalesOrder, createZohoInvoiceFromSO, updateZohoShipment, updateZohoSOOrderId, markZohoInvoiceAsSent };
