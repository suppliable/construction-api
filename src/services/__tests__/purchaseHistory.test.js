'use strict';

// The comparison these tests pin is the whole point of the feature: bills are
// recorded EXCLUSIVE of GST and selling prices INCLUSIVE, so a line that looks
// profitable on the bill can be underwater once GST is added. Real example from
// bill 18020 (12 Nov 2026): rate 63.94 excl, 18% GST, selling 65 — which is
// 75.45 paid against 65 charged.

jest.mock('../../utils/firebaseAdmin', () => ({
  firestore: jest.fn(),
  auth: jest.fn(),
  database: jest.fn(),
}));
jest.mock('../../repositories/purchaseHistoryRepository', () => ({
  listAll: jest.fn(),
  getOne: jest.fn(),
  upsertMany: jest.fn(async e => e.length),
  getSyncState: jest.fn(async () => ({})),
  setSyncState: jest.fn(),
}));
jest.mock('../zohoHttp', () => ({ zohoGet: jest.fn() }));

const { marginFor, entriesFromBill, reduceToLatest, toInclusive, billDiscountFactor, lineDiscountFactor } = require('../purchaseHistoryService');

describe('toInclusive', () => {
  test('adds GST to an exclusive bill rate', () => {
    expect(toInclusive(63.94, 18, false)).toBe(75.45);
    expect(toInclusive(100, 18, false)).toBe(118);
  });

  test('leaves an inclusive rate alone', () => {
    expect(toInclusive(118, 18, true)).toBe(118);
  });

  test('zero GST is a pass-through either way', () => {
    expect(toInclusive(50, 0, false)).toBe(50);
    expect(toInclusive(50, 0, true)).toBe(50);
  });
});

describe('marginFor', () => {
  test('the real case: profitable-looking bill rate is actually underwater', () => {
    // 63.94 excl reads as cheaper than the 65 selling price — until GST.
    const m = marginFor({ rate: 65 }, { rateIncl: 75.45 });
    expect(m.status).toBe('underwater');
    expect(m.marginValue).toBe(-10.45);
    expect(m.marginPct).toBeCloseTo(-16.08, 1);
  });

  test('a healthy margin', () => {
    const m = marginFor({ rate: 118 }, { rateIncl: 94.4 });
    expect(m.status).toBe('ok');
    expect(m.marginPct).toBe(20);
  });

  test('buying at exactly the selling price counts as underwater, not ok', () => {
    // No margin floor was wanted, but zero margin is still not a sale worth making.
    const m = marginFor({ rate: 100 }, { rateIncl: 100 });
    expect(m.status).toBe('underwater');
    expect(m.marginPct).toBe(0);
  });

  test('never billed -> no_purchase, not a zero margin', () => {
    const m = marginFor({ rate: 100 }, null);
    expect(m.status).toBe('no_purchase');
    expect(m.marginPct).toBeNull();
  });

  test('no selling price -> no_price, margin undefined rather than 100%', () => {
    const m = marginFor({ rate: 0 }, { rateIncl: 50 });
    expect(m.status).toBe('no_price');
    expect(m.marginPct).toBeNull();
  });
});

describe('entriesFromBill', () => {
  const bill = {
    bill_id: 'B1', bill_number: '18020', date: '2026-11-12',
    vendor_id: 'V1', vendor_name: 'Ashirvad',
    is_inclusive_tax: false,
    line_items: [
      { item_id: 'I1', name: 'Brass Reducer', rate: 63.94, quantity: 10, tax_percentage: 18 },
      { item_id: '', name: 'Freight', rate: 500, quantity: 1, tax_percentage: 0 },
    ],
  };

  test('stores both bases so no reader has to know the bill convention', () => {
    const [e] = entriesFromBill(bill);
    expect(e.rateExcl).toBe(63.94);
    expect(e.rateIncl).toBe(75.45);
    expect(e.lastBillNumber).toBe('18020');
    expect(e.vendorName).toBe('Ashirvad');
  });

  test('skips non-item lines — freight has nothing to compare against', () => {
    expect(entriesFromBill(bill)).toHaveLength(1);
  });

  test('an inclusive bill is back-converted for rateExcl', () => {
    const [e] = entriesFromBill({
      ...bill, is_inclusive_tax: true,
      line_items: [{ item_id: 'I1', rate: 118, quantity: 1, tax_percentage: 18 }],
    });
    expect(e.rateIncl).toBe(118);
    expect(e.rateExcl).toBe(100);
  });

  test('a bill with no lines yields nothing', () => {
    expect(entriesFromBill({ bill_id: 'B9' })).toEqual([]);
  });
});

describe('reduceToLatest', () => {
  test('the newest bill date wins per item', () => {
    const out = reduceToLatest([
      { itemId: 'I1', lastDate: '2026-10-01', rateIncl: 50 },
      { itemId: 'I1', lastDate: '2026-11-12', rateIncl: 75 },
      { itemId: 'I2', lastDate: '2026-09-09', rateIncl: 10 },
    ]);
    expect(out).toHaveLength(2);
    expect(out.find(e => e.itemId === 'I1').rateIncl).toBe(75);
  });

  test('an older bill processed later does not overwrite a newer price', () => {
    const out = reduceToLatest([
      { itemId: 'I1', lastDate: '2026-11-12', rateIncl: 75 },
      { itemId: 'I1', lastDate: '2026-10-01', rateIncl: 50 },
    ]);
    expect(out[0].rateIncl).toBe(75);
  });
});

// ── Discounts ───────────────────────────────────────────────────────────────
// Both shapes are taken from real Asian Paints bills in the org.

describe('billDiscountFactor', () => {
  test('percentage AFTER tax (bill TN2601842025: 8% off 53,299.42 inclusive)', () => {
    expect(billDiscountFactor({
      discount: '8.00%', discount_type: 'entity_level',
      is_discount_before_tax: false, discount_applied_on_amount: 53299.42,
    })).toBeCloseTo(0.92, 6);
  });

  test('percentage BEFORE tax (bill TN2601761297: 5% off 9,320 taxable)', () => {
    expect(billDiscountFactor({
      discount: '5.00%', discount_type: 'entity_level',
      is_discount_before_tax: true, discount_applied_on_amount: 9320,
    })).toBeCloseTo(0.95, 6);
  });

  test('a FLAT discount uses Zoho\'s own base, so pre/post need no special case', () => {
    // 466 off a 9,320 taxable base is the same 5%.
    expect(billDiscountFactor({ discount: 466, discount_applied_on_amount: 9320 })).toBeCloseTo(0.95, 6);
    // The same 466 off an inclusive base is a different, smaller percentage.
    expect(billDiscountFactor({ discount: 466, discount_applied_on_amount: 10998 })).toBeCloseTo(0.9576, 3);
  });

  test('no discount, zero, empty or an unusable base all mean "pay in full"', () => {
    expect(billDiscountFactor({})).toBe(1);
    expect(billDiscountFactor({ discount: 0 })).toBe(1);
    expect(billDiscountFactor({ discount: '' })).toBe(1);
    expect(billDiscountFactor({ discount: '0.00%' })).toBe(1);
    expect(billDiscountFactor({ discount: 500, discount_applied_on_amount: 0 })).toBe(1);
  });
});

describe('lineDiscountFactor', () => {
  test('an itemised discount amount is taken against the line gross', () => {
    expect(lineDiscountFactor({ rate: 100, quantity: 10, discount_amount: 50 })).toBeCloseTo(0.95, 6);
  });
  test('a line percentage works too', () => {
    expect(lineDiscountFactor({ rate: 100, quantity: 10, discount: '5%' })).toBeCloseTo(0.95, 6);
  });
  test('no line discount is the common case today', () => {
    expect(lineDiscountFactor({ rate: 100, quantity: 10 })).toBe(1);
  });
});

describe('entriesFromBill with a discount', () => {
  const postTax = {
    bill_id: 'B1', bill_number: 'TN2601842025', date: '2026-11-04',
    vendor_name: 'ASIAN PAINTS LIMITED', is_inclusive_tax: false,
    discount: '8.00%', discount_type: 'entity_level',
    is_discount_before_tax: false, discount_applied_on_amount: 53299.42,
    line_items: [{ item_id: 'I1', name: 'Apcolite 1L', rate: 285, quantity: 6, tax_percentage: 18 }],
  };
  const preTax = {
    ...postTax, bill_number: 'TN2601761297', date: '2026-10-14',
    discount: '5.00%', is_discount_before_tax: true, discount_applied_on_amount: 9320,
    line_items: [{ item_id: 'I2', name: 'Apex 1L', rate: 312, quantity: 6, tax_percentage: 18 }],
  };

  test('post-tax discount nets down the recorded cost', () => {
    const [e] = entriesFromBill(postTax);
    expect(e.grossRateIncl).toBe(336.3);   // 285 + 18%
    expect(e.rateIncl).toBe(309.4);        // less 8%
    expect(e.discountPct).toBe(8);
  });

  test('pre-tax discount nets down the same way', () => {
    const [e] = entriesFromBill(preTax);
    expect(e.grossRateIncl).toBe(368.16);  // 312 + 18%
    expect(e.rateIncl).toBe(349.75);       // less 5%
    expect(e.discountPct).toBe(5);
  });

  test('ordering does not matter — the per-unit cost is identical either way', () => {
    const asPost = entriesFromBill(postTax)[0].rateIncl;
    const asPre = entriesFromBill({ ...postTax, is_discount_before_tax: true, discount_applied_on_amount: 45169 })[0].rateIncl;
    expect(asPre).toBe(asPost);
  });

  test('an undiscounted bill records the gross rate unchanged', () => {
    const [e] = entriesFromBill({ ...postTax, discount: 0, discount_applied_on_amount: 0 });
    expect(e.rateIncl).toBe(e.grossRateIncl);
    expect(e.discountPct).toBe(0);
  });
});

// ── Extraction version gate ─────────────────────────────────────────────────
// Incremental sync never revisits an old bill, so records written by superseded
// logic stay wrong indefinitely. That is not hypothetical: when discounts began
// being netted off, prod was corrected by a manual full backfill while dev kept
// serving the old gross figures, because its watermark said there was nothing
// to do.

const repo = require('../../repositories/purchaseHistoryRepository');
const { zohoGet } = require('../zohoHttp');
const { syncFromBills, EXTRACTION_VERSION } = require('../purchaseHistoryService');

function mockBills(rows) {
  zohoGet.mockImplementation(async (url) => {
    if (url.endsWith('/bills')) {
      return { data: { bills: rows, page_context: { has_more_page: false } } };
    }
    const id = url.split('/').pop();
    return { data: { bill: { bill_id: id, bill_number: id, date: '2026-11-01', line_items: [] } } };
  });
}

describe('sync re-walks when the extraction version moves', () => {
  const bills = [
    { bill_id: 'B1', last_modified_time: '2026-10-01T00:00:00+0530' },
    { bill_id: 'B2', last_modified_time: '2026-11-01T00:00:00+0530' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    repo.upsertMany.mockResolvedValue(0);
    mockBills(bills);
  });

  test('a watermark from an OLDER version is ignored — every bill is re-read', async () => {
    repo.getSyncState.mockResolvedValue({
      lastModifiedTime: '2026-11-30T00:00:00+0530', logicVersion: EXTRACTION_VERSION - 1,
    });
    const res = await syncFromBills({});
    expect(res.billsChanged).toBe(2);
    expect(res.fullRewalk).toBe(true);
  });

  test('a pre-versioning watermark counts as stale, so dev self-heals', async () => {
    // What dev actually has: a watermark written before logicVersion existed.
    repo.getSyncState.mockResolvedValue({ lastModifiedTime: '2026-11-30T00:00:00+0530' });
    const res = await syncFromBills({});
    expect(res.billsChanged).toBe(2);
    expect(res.fullRewalk).toBe(true);
  });

  test('a current-version watermark is honoured — only newer bills are fetched', async () => {
    repo.getSyncState.mockResolvedValue({
      lastModifiedTime: '2026-10-15T00:00:00+0530', logicVersion: EXTRACTION_VERSION,
    });
    const res = await syncFromBills({});
    expect(res.billsChanged).toBe(1); // B2 only
    expect(res.fullRewalk).toBe(false);
  });

  test('the version is recorded with the watermark, so the next run can compare', async () => {
    repo.getSyncState.mockResolvedValue({});
    await syncFromBills({});
    expect(repo.setSyncState).toHaveBeenCalledWith(
      '2026-11-01T00:00:00+0530', EXTRACTION_VERSION, expect.any(Object), null
    );
  });

  test('a dry run never advances the watermark', async () => {
    repo.getSyncState.mockResolvedValue({});
    await syncFromBills({ dryRun: true });
    expect(repo.setSyncState).not.toHaveBeenCalled();
  });
});
