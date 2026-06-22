const { createSpan } = require('../utils/spanTracer');
const { zohoPost, zohoPut } = require('./zohoHttp');

// Zoho rejects shipping_address when the *serialized* object reaches 100 chars
// ("must be less than 100 characters") — keys, braces and quotes are counted,
// not just the values. `{"address":"<value>"}` is a 14-char wrapper, so the
// value must stay <= 85 to keep the whole object under 100. Adding any extra
// key (attention, city, etc.) spends that budget on wrapper text and breaks it,
// which is why the original code used a single 85-char `address` field.
const ZOHO_ADDRESS_VALUE_MAX = 85;

/**
 * Single-line address for the sales-order create payload, where Zoho enforces
 * the <100-char serialized limit. Everything is joined into one `address`
 * field capped at 85.
 */
function buildZohoShippingAddress(shippingAddress = {}) {
  const addr = shippingAddress || {};
  const address = [addr.flatNo, addr.buildingName, addr.streetAddress, addr.landmark, addr.area, addr.city, addr.state, addr.pincode]
    .filter(Boolean).join(', ').substring(0, ZOHO_ADDRESS_VALUE_MAX);
  return { address };
}

/**
 * Structured address for the dedicated invoice shipping-address endpoint
 * (PUT /invoices/:id/address/shipping), which accepts separate fields and is
 * not subject to the create-payload serialized limit. This is what actually
 * populates the invoice's printed Ship To.
 */
function buildInvoiceShippingAddress(shippingAddress = {}) {
  const addr = shippingAddress || {};
  return {
    address: [addr.flatNo, addr.buildingName, addr.streetAddress, addr.landmark, addr.area]
      .filter(Boolean).join(', ').substring(0, 100),
    city: (addr.city || '').substring(0, 100),
    state: (addr.state || '').substring(0, 100),
    zip: (addr.pincode || '').toString().substring(0, 20),
    country: 'India',
  };
}

async function createZohoSalesOrder(zohoContactId, lineItems, shippingAddress, deliveryCharge, phone, traceContext = null, gstDetails = {}) {
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
    const shipping_address = buildZohoShippingAddress(shippingAddress);
    console.log('[Zoho SO] shipping_address being sent:', JSON.stringify(shipping_address),
      '| serialized length:', JSON.stringify(shipping_address).length);
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

async function updateZohoInvoiceShippingAddress(invoice_id, shippingAddress, traceContext = null) {
  const span = createSpan(traceContext, 'zoho.api.updateInvoiceShippingAddress', {
    'peer.service': 'zoho',
    invoice_id,
    endpoint: '/inventory/v1/invoices/:id/address/shipping'
  });
  try {
    // Invoices created via fromsalesorder inherit the contact's stored shipping
    // address (none, in our case) — so we set the delivery address explicitly
    // here via Zoho's dedicated shipping-address endpoint. A plain PUT to
    // /invoices/:id with a shipping_address body is ignored by Zoho.
    const body = buildInvoiceShippingAddress(shippingAddress);
    console.log('[Zoho INV] setting shipping address:', invoice_id, JSON.stringify(body));
    const res = await zohoPut(
      `${process.env.ZOHO_API_DOMAIN}/inventory/v1/invoices/${invoice_id}/address/shipping`,
      body
    );
    console.log('[Zoho INV] shipping address response:', res.data?.code, res.data?.message);
    span.end({ success: true, invoice_id });
  } catch (error) {
    console.log('[Zoho INV] shipping address ERROR:', JSON.stringify(error.response?.data) || error.message);
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
