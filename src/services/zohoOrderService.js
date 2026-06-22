const { createSpan } = require('../utils/spanTracer');
const { zohoPost, zohoPut } = require('./zohoHttp');

// Zoho rejects a shipping_address whose *combined* field text reaches 100
// characters ("must be less than 100 characters") — it's a limit on the whole
// object, not a single field. So we pack the address into one consolidated
// `address` line and keep attention + address comfortably under the limit.
const ZOHO_ADDRESS_TOTAL_MAX = 90;
const ZOHO_ATTENTION_MAX = 30;

/**
 * Maps a Firestore delivery-address document to Zoho's address object. All the
 * address parts are joined into the single `address` line (the shape Zoho
 * reliably accepts), and attention + address are budgeted to stay under Zoho's
 * 100-char combined limit. Shared by the sales order and the invoice so both
 * render the same Ship To.
 */
function buildZohoShippingAddress(shippingAddress = {}, attention = '') {
  const addr = shippingAddress || {};
  const att = (attention || '').substring(0, ZOHO_ATTENTION_MAX);
  const addressBudget = Math.max(0, ZOHO_ADDRESS_TOTAL_MAX - att.length);
  const address = [addr.flatNo, addr.buildingName, addr.streetAddress, addr.landmark, addr.area, addr.city, addr.state, addr.pincode]
    .filter(Boolean).join(', ').substring(0, addressBudget);
  return att ? { attention: att, address } : { address };
}

async function createZohoSalesOrder(zohoContactId, lineItems, shippingAddress, deliveryCharge, phone, traceContext = null, gstDetails = {}, attention = '') {
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
    const shipping_address = buildZohoShippingAddress(shippingAddress, attention);
    console.log('[Zoho SO] shipping_address being sent:', JSON.stringify(shipping_address),
      '| field lengths:', Object.fromEntries(Object.entries(shipping_address).map(([k, v]) => [k, String(v).length])));
    const body = {
      customer_id: zohoContactId,
      line_items: zohoLineItems,
      shipping_charge: deliveryCharge || 0,
      shipping_address,
      notes: `Suppliable B2B Order${phone ? ` | Phone: ${phone}` : ''}`
    };
    if (gstDetails.gstNumber) {
      body.gst_no = gstDetails.gstNumber;
      body.gst_treatment = 'business_gst';
    }
    // billing_address is intentionally omitted from the SO body —
    // Zoho uses the contact's stored billing address (set via updateZohoContact before this call)

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

async function updateZohoInvoiceShippingAddress(invoice_id, shippingAddress, attention, traceContext = null) {
  const span = createSpan(traceContext, 'zoho.api.updateInvoiceShippingAddress', {
    'peer.service': 'zoho',
    invoice_id,
    endpoint: '/inventory/v1/invoices/:id'
  });
  try {
    // Invoices created via fromsalesorder inherit the contact's stored shipping
    // address (none, in our case) — so we set the delivery address explicitly
    // here to populate the invoice's Ship To.
    await zohoPut(
      `${process.env.ZOHO_API_DOMAIN}/inventory/v1/invoices/${invoice_id}`,
      { shipping_address: buildZohoShippingAddress(shippingAddress, attention) }
    );
    span.end({ success: true, invoice_id });
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

module.exports = { createZohoSalesOrder, confirmZohoSalesOrder, createZohoInvoiceFromSO, updateZohoShipment, updateZohoSOOrderId, updateZohoInvoiceShippingAddress, markZohoInvoiceAsSent };
