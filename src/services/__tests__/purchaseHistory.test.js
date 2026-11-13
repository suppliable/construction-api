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
  getWatermark: jest.fn(),
  setWatermark: jest.fn(),
}));
jest.mock('../zohoHttp', () => ({ zohoGet: jest.fn() }));

const { marginFor, entriesFromBill, reduceToLatest, toInclusive } = require('../purchaseHistoryService');

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
