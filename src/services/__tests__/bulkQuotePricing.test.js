'use strict';

// Bulk quote rates are GST-INCLUSIVE, matching the catalogue, the cart and the
// order. These tests pin the money math, because the failure mode is silent:
// an approved quote's items become the order's line items verbatim and then the
// Zoho sales order, which divides unitPrice down by the GST rate. While quotes
// stored an EXCLUSIVE rate, that raised an invoice ~15% below what was paid.

jest.mock('../../utils/firebaseAdmin', () => ({
  firestore: jest.fn(),
  auth: jest.fn(),
  database: jest.fn(),
}));
jest.mock('../../repositories/bulkRepository', () => ({
  listCategoryOverlays: jest.fn(async () => []),
  getQuote: jest.fn(),
  updateQuote: jest.fn(async (id, data) => ({ id, ...data })),
  saveQuote: jest.fn(async q => q),
  getPhotoSlots: jest.fn(async () => []),
}));
jest.mock('../../services/productService', () => ({
  getAllProducts: jest.fn(async () => []),
  getProductById: jest.fn(),
}));
jest.mock('../../services/remoteConfigService', () => ({
  getString: jest.fn(async (_k, d) => d),
  getNumber: jest.fn(async (_k, d) => d),
}));
jest.mock('../../services/storageService', () => ({
  getSignedUploadUrl: jest.fn(),
  getSignedReadUrl: jest.fn(),
}));
jest.mock('../slackService', () => ({
  postNewQuoteRequest: jest.fn(async () => ({ ts: null })),
  updateQuoteStatus: jest.fn(async () => {}),
}));

const bulkRepo = require('../../repositories/bulkRepository');
const bulkService = require('../bulkService');

beforeEach(() => jest.clearAllMocks());

/** 100 bags at ₹118 incl. 18% GST = ₹10,000 base + ₹1,800 GST. */
const ROW = { name: 'UltraTech Cement 50kg', quantity: 100, unit: 'bags', unitPrice: 118, gstRate: 18 };

async function publish(rows, deliveryCharge = 0) {
  bulkRepo.getQuote.mockResolvedValue({ id: 'QT-1', status: 'requested', items: [] });
  await bulkService.publishQuote('QT-1', { items: rows, deliveryCharge });
  return bulkRepo.updateQuote.mock.calls[0][1];
}

describe('publishQuote — the rate is GST-inclusive', () => {
  test('extracts GST from the rate instead of adding it on top', async () => {
    const q = await publish([ROW]);
    expect(q.subtotal).toBe(10000);
    expect(q.gstAmount).toBe(1800);
    // What the customer pays is exactly qty × rate — the whole point of an
    // inclusive rate is that ops types the final number.
    expect(q.grandTotal).toBe(11800);
  });

  test('stores the per-line split the order shape needs', async () => {
    const q = await publish([ROW]);
    expect(q.items[0]).toMatchObject({
      unitPrice: 118,
      gstRate: 18,
      totalWithoutGST: 10000,
      gstAmount: 1800,
      grandTotal: 11800,
    });
  });

  test('totals are summed from the lines, so they cannot disagree', async () => {
    const q = await publish([
      ROW,
      { name: 'River Sand', quantity: 3, unit: 'units', unitPrice: 5250, gstRate: 5 },
    ]);
    const lineSum = q.items.reduce((s, i) => s + i.grandTotal, 0);
    expect(Math.round((q.subtotal + q.gstAmount) * 100) / 100).toBe(Math.round(lineSum * 100) / 100);
  });

  test('a zero-GST line passes the rate straight through', async () => {
    const q = await publish([{ ...ROW, gstRate: 0 }]);
    expect(q.subtotal).toBe(11800);
    expect(q.gstAmount).toBe(0);
    expect(q.grandTotal).toBe(11800);
  });

  test('delivery is added on top of the inclusive lines', async () => {
    const q = await publish([ROW], 2500);
    expect(q.grandTotal).toBe(14300);
  });

  test('marks the quote so legacy exclusive-priced ones stay identifiable', async () => {
    expect((await publish([ROW])).priceIncludesGst).toBe(true);
  });
});

describe('order line items from a quote', () => {
  // approveQuote is the only caller; exercising it end-to-end would need a
  // payment gateway, so the conversion is asserted through publish + approve's
  // shared helper via the exported surface it feeds.
  const legacy = {
    id: 'QT-OLD',
    // No priceIncludesGst — priced before the change, so ₹100 is EXCLUSIVE.
    items: [{ name: 'Cement', quantity: 100, unit: 'bags', unitPrice: 100, gstRate: 18 }],
  };
  const current = {
    id: 'QT-NEW',
    priceIncludesGst: true,
    items: [{ name: 'Cement', quantity: 100, unit: 'bags', unitPrice: 118, gstRate: 18 }],
  };

  test('a legacy exclusive rate is converted to inclusive, so Zoho invoices the amount collected', () => {
    const [line] = bulkService._test.orderLineItemsFromQuote(legacy);
    // 100 excl + 18% = 118 incl. Zoho divides this back to 100 for its own
    // base rate and re-adds GST, landing on the ₹11,800 the customer paid.
    expect(line.unitPrice).toBe(118);
    expect(line.grandTotal).toBe(11800);
    expect(line.totalWithoutGST).toBe(10000);
  });

  test('a current quote is passed through unchanged', () => {
    const [line] = bulkService._test.orderLineItemsFromQuote(current);
    expect(line.unitPrice).toBe(118);
    expect(line.grandTotal).toBe(11800);
  });

  test('both conventions produce the same order value for the same real price', () => {
    const a = bulkService._test.orderLineItemsFromQuote(legacy)[0].grandTotal;
    const b = bulkService._test.orderLineItemsFromQuote(current)[0].grandTotal;
    expect(a).toBe(b);
  });

  test('keeps the fields the sales order needs', () => {
    const [line] = bulkService._test.orderLineItemsFromQuote({
      ...current,
      items: [{ ...current.items[0], zohoItemId: 'ITEM-9', variantName: '50kg' }],
    });
    expect(line.zohoItemId).toBe('ITEM-9');
    expect(line.variantName).toBe('50kg');
  });
});
