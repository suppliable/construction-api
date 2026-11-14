'use strict';

// The bill form exists because a purchase rate is quoted EXCLUSIVE of GST and a
// selling price INCLUSIVE, so the two cannot be compared as printed. These
// tests pin that conversion, the discount handling, and the Zoho payload —
// money maths that fails silently if it is wrong.

jest.mock('../../utils/firebaseAdmin', () => ({
  firestore: jest.fn(), auth: jest.fn(), database: jest.fn(),
}));
jest.mock('../zohoHttp', () => ({ zohoPost: jest.fn(), zohoGet: jest.fn() }));
jest.mock('../../repositories/purchaseHistoryRepository', () => ({
  upsertMany: jest.fn(async () => 1),
  getSyncState: jest.fn(), setSyncState: jest.fn(), listAll: jest.fn(), getOne: jest.fn(),
}));

const { zohoPost } = require('../zohoHttp');
const repo = require('../../repositories/purchaseHistoryRepository');
const {
  assembleBill, billTotals, lineMargins, toZohoPayload, createBill,
} = require('../billService');

beforeEach(() => jest.clearAllMocks());

const base = (over = {}) => ({
  vendorId: 'V1',
  billNumber: 'TN123',
  date: '2026-11-14',
  rateMode: 'excl',
  lines: [{ itemId: 'I1', name: 'Brass Reducer', quantity: 10, rate: 63.94, gstRate: 18, unit: 'Pcs' }],
  ...over,
});

describe('assembleBill — rate basis', () => {
  test('an exclusive rate is grossed up, so cost can meet a selling price', () => {
    const [l] = assembleBill(base()).lines;
    expect(l.rateExcl).toBe(63.94);
    expect(l.rateIncl).toBe(75.45);
  });

  test('an inclusive rate is split back down', () => {
    const [l] = assembleBill(base({ rateMode: 'incl', lines: [{ itemId: 'I1', quantity: 1, rate: 118, gstRate: 18 }] })).lines;
    expect(l.rateIncl).toBe(118);
    expect(l.rateExcl).toBe(100);
  });

  test('zero GST passes through on both bases', () => {
    const [l] = assembleBill(base({ lines: [{ itemId: 'I1', quantity: 1, rate: 50, gstRate: 0 }] })).lines;
    expect(l.rateExcl).toBe(50);
    expect(l.rateIncl).toBe(50);
  });
});

describe('assembleBill — validation', () => {
  test.each([
    [{ vendorId: '' }, /Select a vendor/],
    [{ billNumber: '' }, /bill number/],
    [{ date: '14-11-2026' }, /YYYY-MM-DD/],
    [{ rateMode: 'sometimes' }, /rateMode/],
    [{ lines: [] }, /at least one line/],
    [{ lines: [{ itemId: '', quantity: 1, rate: 1 }] }, /Line 1: pick an item/],
    [{ lines: [{ itemId: 'I1', quantity: 0, rate: 1 }] }, /Line 1: enter a quantity/],
    [{ lines: [{ itemId: 'I1', quantity: 1, rate: -5 }] }, /Line 1: enter a rate/],
    [{ discount: 120 }, /cannot exceed 100/],
    [{ discount: -5 }, /cannot be negative/],
  ])('rejects %j', (over, msg) => {
    expect(() => assembleBill(base(over))).toThrow(msg);
  });

  test('names the offending line, not just "invalid"', () => {
    expect(() => assembleBill(base({
      lines: [
        { itemId: 'I1', quantity: 1, rate: 1 },
        { itemId: 'I2', quantity: 1, rate: 'abc' },
      ],
    }))).toThrow(/Line 2/);
  });
});

describe('billTotals', () => {
  const bill = assembleBill(base({
    lines: [{ itemId: 'I1', quantity: 6, rate: 285, gstRate: 18 }],
  }));

  test('undiscounted: tax is the gap between the two bases', () => {
    const t = billTotals(bill);
    expect(t.taxable).toBe(1710);
    expect(t.tax).toBe(307.8);
    expect(t.total).toBe(2017.8);
  });

  test('a discount BEFORE tax reduces the tax with it', () => {
    const t = billTotals(assembleBill(base({
      lines: [{ itemId: 'I1', quantity: 6, rate: 285, gstRate: 18 }],
      discount: 8, discountBeforeTax: true,
    })));
    expect(t.discountBase).toBe(1710);        // taxable
    expect(t.discount).toBe(136.8);
    expect(t.total).toBe(1856.38);            // (1710-136.8) x 1.18
  });

  test('a discount AFTER tax comes off the gross, leaving tax alone', () => {
    const t = billTotals(assembleBill(base({
      lines: [{ itemId: 'I1', quantity: 6, rate: 285, gstRate: 18 }],
      discount: 8, discountBeforeTax: false,
    })));
    expect(t.discountBase).toBe(2017.8);      // tax-inclusive
    expect(t.discount).toBe(161.42);
    expect(t.total).toBe(1856.38);
  });

  test('the cash payable is the same either way — only the GST differs', () => {
    const mk = before => billTotals(assembleBill(base({
      lines: [{ itemId: 'I1', quantity: 6, rate: 285, gstRate: 18 }],
      discount: 8, discountBeforeTax: before,
    })));
    expect(mk(true).total).toBe(mk(false).total);
    expect(mk(true).discount).not.toBe(mk(false).discount);
  });

  test('a flat discount is taken as rupees, not a percentage', () => {
    const t = billTotals(assembleBill(base({
      lines: [{ itemId: 'I1', quantity: 6, rate: 285, gstRate: 18 }],
      discount: 100, discountIsPercent: false, discountBeforeTax: true,
    })));
    expect(t.discount).toBe(100);
  });
});

describe('lineMargins', () => {
  const items = new Map([['I1', { itemId: 'I1', name: 'Brass Reducer', sellingRate: 65 }]]);

  test('the real case: 63.94 looks under 65 but is 16% underwater', () => {
    const [m] = lineMargins(assembleBill(base()), items);
    expect(m.costIncl).toBe(75.45);
    expect(m.status).toBe('underwater');
    expect(m.marginPct).toBeCloseTo(-16.08, 1);
  });

  test('a bill discount can rescue a line that looks underwater gross', () => {
    const bill = assembleBill(base({ discount: 20, discountBeforeTax: true }));
    const [m] = lineMargins(bill, items);
    expect(m.costIncl).toBe(60.36);
    expect(m.status).toBe('ok');
  });

  test('an unknown item reports no_price rather than a wrong margin', () => {
    const [m] = lineMargins(assembleBill(base()), new Map());
    expect(m.status).toBe('no_price');
    expect(m.marginPct).toBeNull();
  });
});

describe('toZohoPayload', () => {
  test('sends the rate as typed and declares the basis', () => {
    const p = toZohoPayload(assembleBill(base({ rateMode: 'incl' })));
    expect(p.is_inclusive_tax).toBe(true);
    expect(p.line_items[0]).toMatchObject({ item_id: 'I1', rate: 63.94, quantity: 10 });
  });

  test('a percentage discount goes as Zoho formats it', () => {
    const p = toZohoPayload(assembleBill(base({ discount: 5, discountBeforeTax: true })));
    expect(p.discount).toBe('5%');
    expect(p.discount_type).toBe('entity_level');
    expect(p.is_discount_before_tax).toBe(true);
  });

  test('a flat discount goes as a number', () => {
    const p = toZohoPayload(assembleBill(base({ discount: 250, discountIsPercent: false })));
    expect(p.discount).toBe(250);
  });

  test('no discount field at all when there is none', () => {
    expect(toZohoPayload(assembleBill(base()))).not.toHaveProperty('discount');
  });
});

describe('createBill', () => {
  const zohoBill = {
    bill_id: 'B9', bill_number: 'TN123', date: '2026-11-14',
    total: 754.5, vendor_name: 'Ashirvad', is_inclusive_tax: false,
    line_items: [{ item_id: 'I1', name: 'Brass Reducer', rate: 63.94, quantity: 10, tax_percentage: 18 }],
  };

  test('creates in Zoho and folds the result into purchase history', async () => {
    zohoPost.mockResolvedValue({ data: { bill: zohoBill } });
    const out = await createBill(base());
    expect(out).toMatchObject({ billId: 'B9', billNumber: 'TN123' });

    // History comes from Zoho's OWN response, so the report shows what Zoho
    // recorded rather than what the form submitted.
    const [entries] = repo.upsertMany.mock.calls[0];
    expect(entries[0]).toMatchObject({ itemId: 'I1', rateIncl: 75.45 });
  });

  test('a history write failure does not fail the bill — Zoho already has it', async () => {
    zohoPost.mockResolvedValue({ data: { bill: zohoBill } });
    repo.upsertMany.mockRejectedValue(new Error('firestore down'));
    await expect(createBill(base())).resolves.toMatchObject({ billId: 'B9' });
  });

  test('validation runs before anything is sent to Zoho', async () => {
    await expect(createBill(base({ lines: [] }))).rejects.toThrow(/at least one line/);
    expect(zohoPost).not.toHaveBeenCalled();
  });

  test('a response with no bill is surfaced, not treated as success', async () => {
    zohoPost.mockResolvedValue({ data: {} });
    await expect(createBill(base())).rejects.toThrow(/did not return a bill/);
  });
});
