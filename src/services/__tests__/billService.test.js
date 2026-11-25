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
  saveRowDiscounts: jest.fn(async () => {}), getRowDiscounts: jest.fn(),
  getSyncState: jest.fn(), setSyncState: jest.fn(), listAll: jest.fn(), getOne: jest.fn(),
}));

const { zohoPost, zohoGet } = require('../zohoHttp');
const repo = require('../../repositories/purchaseHistoryRepository');
const {
  assembleBill, billTotals, lineMargins, toZohoPayload, createBill,
  taxIdFor, vendorTaxSpecification,
} = require('../billService');

// The org's real tax set: intra-state GST groups, inter-state IGST taxes.
const TAXES = { data: { taxes: [
  { tax_id: 'GST18', tax_percentage: 18, tax_specification: 'intra', tax_type: 'tax_group' },
  { tax_id: 'GST5',  tax_percentage: 5,  tax_specification: 'intra', tax_type: 'tax_group' },
  { tax_id: 'GST0',  tax_percentage: 0,  tax_specification: 'intra', tax_type: 'tax_group' },
  { tax_id: 'IGST18', tax_percentage: 18, tax_specification: 'inter', tax_type: 'tax' },
] } };
const vendorWith = gstin => ({ data: { contact: { gst_no: gstin } } });

const DISCOUNT_ACCOUNTS = {
  data: {
    chartofaccounts: [
      { account_id: 'ACC-INCOME', account_name: 'Discount', account_type: 'income', is_active: true },
      { account_id: 'ACC-PURCH', account_name: 'Purchase Discounts', account_type: 'expense', is_active: true },
    ],
  },
};

// createBill resolves the vendor's tax family, the tax list and (when
// discounted) the discount account, so every test that creates a bill needs all
// three routed. Re-installed wherever a describe clears mocks.
function routeZoho() {
  zohoGet.mockImplementation(async (url) => {
    if (url.includes('/contacts/')) return vendorWith('33AAACA3622K1Z2');
    if (url.includes('/settings/taxes')) return TAXES;
    if (url.includes('/chartofaccounts')) return DISCOUNT_ACCOUNTS;
    return { data: {} };
  });
}

beforeEach(() => { jest.clearAllMocks(); routeZoho(); });

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

  test('does NOT send unit — Zoho takes it from the item and rejects free text', () => {
    // The catalogue's unit is whatever was typed in Zoho ("box", "Pcs"), which
    // is not necessarily a unit the org has configured, so sending it can only
    // fail.
    const p = toZohoPayload(assembleBill(base()));
    expect(p.line_items[0]).not.toHaveProperty('unit');
  });

  test('carries the discount account when one is given', () => {
    const p = toZohoPayload(assembleBill(base({ discount: 5 })), { discountAccountId: 'ACC-PURCH' });
    expect(p.discount_account_id).toBe('ACC-PURCH');
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

  test('a Zoho rejection carries the payload, so the log can name what was refused', async () => {
    const err = new Error('Request failed');
    err.response = { data: { code: 1001, message: 'Invalid value passed for unit' } };
    zohoPost.mockRejectedValue(err);
    await expect(createBill(base())).rejects.toMatchObject({
      zohoPayload: expect.objectContaining({ bill_number: 'TN123' }),
    });
  });

  test('a response with no bill is surfaced, not treated as success', async () => {
    zohoPost.mockResolvedValue({ data: {} });
    await expect(createBill(base())).rejects.toThrow(/did not return a bill/);
  });
});

// ── Discount account ────────────────────────────────────────────────────────
// Zoho refuses a discounted bill without one: "Associate an account for
// discount." The org has two candidates and only one is correct.

describe('purchase discount account', () => {
  const svc = require('../billService');

  beforeEach(() => {
    delete process.env.ZOHO_PURCHASE_DISCOUNT_ACCOUNT_ID;
    svc._resetDiscountAccountCache();
    routeZoho();
  });

  test('picks the EXPENSE "Purchase Discounts" account, not the income "Discount" one', async () => {
    zohoGet.mockResolvedValue(DISCOUNT_ACCOUNTS);
    await expect(svc.purchaseDiscountAccountId()).resolves.toBe('ACC-PURCH');
  });

  test('resolves once, then serves from cache — it never changes', async () => {
    zohoGet.mockResolvedValue(DISCOUNT_ACCOUNTS);
    await svc.purchaseDiscountAccountId();
    await svc.purchaseDiscountAccountId();
    expect(zohoGet).toHaveBeenCalledTimes(1);
  });

  test('says what to do when no discount account exists', async () => {
    zohoGet.mockResolvedValue({ data: { chartofaccounts: [] } });
    await expect(svc.purchaseDiscountAccountId())
      .rejects.toThrow(/Purchase Discounts.*ZOHO_PURCHASE_DISCOUNT_ACCOUNT_ID/s);
  });

  test('an undiscounted bill never looks the discount account up', async () => {
    zohoPost.mockResolvedValue({ data: { bill: { bill_id: 'B1', bill_number: 'X', line_items: [] } } });
    await createBill(base());
    const urls = zohoGet.mock.calls.map(c => c[0]);
    expect(urls.some(u => u.includes('/chartofaccounts'))).toBe(false);
  });

  test('a discounted bill sends the account id', async () => {
    // Uses the shared router: createBill needs the vendor, the tax list AND
    // the discount account, so a blanket mockResolvedValue would starve two of
    // the three.
    zohoPost.mockResolvedValue({ data: { bill: { bill_id: 'B2', bill_number: 'Y', line_items: [] } } });
    await createBill(base({ discount: 5 }));
    const [, payload] = zohoPost.mock.calls[0];
    expect(payload.discount_account_id).toBeTruthy();
    expect(payload.discount).toBe('5%');
  });

  test('an explicit env id wins, so it can be pinned', async () => {
    process.env.ZOHO_PURCHASE_DISCOUNT_ACCOUNT_ID = 'ACC-PINNED';
    zohoPost.mockResolvedValue({ data: { bill: { bill_id: 'B3', bill_number: 'Z', line_items: [] } } });
    await createBill(base({ discount: 5 }));
    expect(zohoPost.mock.calls[0][1].discount_account_id).toBe('ACC-PINNED');
    const urls = zohoGet.mock.calls.map(c => c[0]);
    expect(urls.some(u => u.includes('/chartofaccounts'))).toBe(false);
    delete process.env.ZOHO_PURCHASE_DISCOUNT_ACCOUNT_ID;
  });
});

// ── Line tax ────────────────────────────────────────────────────────────────
// Zoho rejects a bill line with no tax: "Specify either a Tax or Tax Exemption
// or Reverse Charge." Which family applies is decided by where the vendor is,
// not by preference.

describe('line tax', () => {
  const svc = require('../billService');
  beforeEach(() => { svc._resetDiscountAccountCache(); jest.clearAllMocks(); routeZoho(); });

  test('a Tamil Nadu vendor is intra-state — CGST+SGST', async () => {
    zohoGet.mockImplementation(async () => vendorWith('33AAACA3622K1Z2'));
    await expect(vendorTaxSpecification('V1')).resolves.toBe('intra');
  });

  test('an out-of-state vendor is inter-state — IGST', async () => {
    zohoGet.mockImplementation(async () => vendorWith('27AAPFU0939F1ZV'));
    await expect(vendorTaxSpecification('V1')).resolves.toBe('inter');
  });

  test('a vendor with no GSTIN is treated as local, never IGST', async () => {
    zohoGet.mockImplementation(async () => vendorWith(''));
    await expect(vendorTaxSpecification('V1')).resolves.toBe('intra');
  });

  test('resolves the tax id by percentage within the right family', async () => {
    await expect(taxIdFor(18, 'intra')).resolves.toBe('GST18');
    await expect(taxIdFor(18, 'inter')).resolves.toBe('IGST18');
  });

  test('zero GST resolves too — it is a real tax, not an absence', async () => {
    await expect(taxIdFor(0, 'intra')).resolves.toBe('GST0');
  });

  test('an unavailable percentage says what to do', async () => {
    await expect(taxIdFor(13, 'intra')).rejects.toThrow(/No GST tax of 13% exists/);
  });

  test('a created bill carries tax_id on every line', async () => {
    zohoPost.mockResolvedValue({ data: { bill: { bill_id: 'B1', bill_number: 'X', line_items: [] } } });

    await createBill(base({
      lines: [
        { itemId: 'I1', quantity: 1, rate: 100, gstRate: 18 },
        { itemId: 'I2', quantity: 1, rate: 50, gstRate: 5 },
      ],
    }));
    const [, payload] = zohoPost.mock.calls[0];
    expect(payload.line_items.map(l => l.tax_id)).toEqual(['GST18', 'GST5']);
  });

  test('looks a rate up once, however many lines share it', async () => {
    zohoPost.mockResolvedValue({ data: { bill: { bill_id: 'B2', bill_number: 'Y', line_items: [] } } });

    await createBill(base({
      lines: [
        { itemId: 'I1', quantity: 1, rate: 100, gstRate: 18 },
        { itemId: 'I2', quantity: 1, rate: 50, gstRate: 18 },
        { itemId: 'I3', quantity: 1, rate: 20, gstRate: 18 },
      ],
    }));
    // one vendor fetch + one tax list fetch, not one per line
    expect(zohoGet).toHaveBeenCalledTimes(2);
  });
});

// ── Row discounts ───────────────────────────────────────────────────────────
// A vendor discounts either the whole bill or each row. The figures for the
// before-GST case are the ones Zoho itself returned for a live test bill.

describe('a discount on each row', () => {
  const svc = require('../billService');
  const rows = (over = {}) => base({
    discountLevel: 'line',
    lines: [
      { itemId: 'I1', quantity: 10, rate: 100, gstRate: 18, discount: 8 },
      { itemId: 'I2', quantity: 3, rate: 200, gstRate: 18, discount: 15, discountIsPercent: false },
      { itemId: 'I3', quantity: 1, rate: 50, gstRate: 18 },
    ],
    ...over,
  });

  beforeEach(() => { jest.clearAllMocks(); svc._resetDiscountAccountCache(); routeZoho(); });

  test('before GST: matches what Zoho computed', () => {
    const bill = assembleBill(rows());
    expect(bill.lines.map(l => l.discountAmount)).toEqual([80, 15, 0]);
    expect(billTotals(bill)).toMatchObject({ discount: 95, total: 1834.9 });
  });

  test('before GST on inclusive rates, the discount comes off the taxable value', () => {
    const bill = assembleBill(rows({ rateMode: 'incl' }));
    expect(bill.lines.map(l => l.discountAmount)).toEqual([67.8, 15, 0]);   // Zoho: 67.8 and 15
    expect(billTotals(bill).total).toBeCloseTo(1552.3, 1);
  });

  test.each([
    [{ discount: 8 }, true, 108.56],
    [{ discount: 8 }, false, 108.56],
    [{ discount: 8, discountIsPercent: false }, true, 108.56],
    [{ discount: 8, discountIsPercent: false }, false, 110],
  ])('cost per unit for %j, before GST = %s, is %s', (disc, before, cost) => {
    const bill = assembleBill(base({
      discountLevel: 'line', discountBeforeTax: before,
      lines: [{ itemId: 'I1', quantity: 1, rate: 100, gstRate: 18, ...disc }],
    }));
    expect(lineMargins(bill)[0].costIncl).toBe(cost);
  });

  test('each row keeps its own cost; nothing spreads to the others', () => {
    expect(lineMargins(assembleBill(rows())).map(m => m.costIncl)).toEqual([108.56, 230.1, 59]);
  });

  test.each([
    [{ discount: 5 }, /not both/],
    [{ lines: [{ itemId: 'I1', quantity: 1, rate: 10, discount: 101 }] }, /Line 1: a percentage/],
    [{ lines: [{ itemId: 'I1', quantity: 1, rate: 10, discount: -1 }] }, /Line 1: discount cannot be negative/],
    [{ lines: [{ itemId: 'I1', quantity: 1, rate: 10, discount: 11, discountIsPercent: false }] }, /more than the line/],
    [{ discountLevel: 'both' }, /discountLevel/],
  ])('rejects %j', (over, msg) => {
    expect(() => assembleBill(rows(over))).toThrow(msg);
  });

  test('row figures are ignored on a whole-bill discount', () => {
    const bill = assembleBill(rows({ discountLevel: 'bill' }));
    expect(billTotals(bill).discount).toBe(0);
    expect(toZohoPayload(bill).line_items[0]).not.toHaveProperty('discount');
  });

  test('before GST goes to Zoho as its own item-level discount, account per row', () => {
    const rowAccountIds = new Map([['I1', 'INV-A'], ['I2', 'INV-B']]);
    const p = toZohoPayload(assembleBill(rows()), { rowAccountIds });
    expect(p).toMatchObject({ discount_type: 'item_level', is_discount_before_tax: true });
    expect(p).not.toHaveProperty('discount');
    expect(p).not.toHaveProperty('discount_account_id');
    expect(p.line_items.map(l => l.discount)).toEqual(['8%', 15, undefined]);
    expect(p.line_items.map(l => l.discount_account_id)).toEqual(['INV-A', 'INV-B', undefined]);
  });

  // Zoho: "The Discount Account must be the same as its Inventory Asset Account".
  const routeItems = items => zohoGet.mockImplementation(async (url) => {
    const m = url.match(/\/books\/v3\/items\/(\w+)$/);
    if (m) return { data: { item: items[m[1]] } };
    if (url.includes('/contacts/')) return vendorWith('33AAACA3622K1Z2');
    if (url.includes('/settings/taxes')) return TAXES;
    return DISCOUNT_ACCOUNTS;
  });
  const created = { data: { bill: { bill_id: 'B9', bill_number: 'X', line_items: [] } } };

  test('a stock-tracked item posts its row discount to its own inventory account', async () => {
    routeItems({
      I1: { track_inventory: true, inventory_account_id: 'INV-A' },
      I2: { track_inventory: false },
    });
    zohoPost.mockResolvedValue(created);
    await createBill(rows());
    expect(zohoPost.mock.calls[0][1].line_items.map(l => l.discount_account_id))
      .toEqual(['INV-A', 'ACC-PURCH', undefined]);
    // the undiscounted third row is never looked up
    expect(zohoGet.mock.calls.some(c => c[0].endsWith('/items/I3'))).toBe(false);
  });

  test('all stock items: Purchase Discounts is not even looked up', async () => {
    routeItems({ I1: { inventory_account_id: 'INV-A' }, I2: { inventory_account_id: 'INV-A' } });
    zohoPost.mockResolvedValue(created);
    await createBill(rows());
    expect(zohoGet.mock.calls.some(c => c[0].includes('/chartofaccounts'))).toBe(false);
  });

  test('if an item cannot be read, no bill is sent with a guessed account', async () => {
    zohoGet.mockImplementation(async (url) => {
      if (url.includes('/books/v3/items/')) throw new Error('zoho down');
      if (url.includes('/contacts/')) return vendorWith('33AAACA3622K1Z2');
      return TAXES;
    });
    await expect(createBill(rows())).rejects.toThrow('zoho down');
    expect(zohoPost).not.toHaveBeenCalled();
  });

  test('after GST goes as one after-tax figure, with each row noted on the bill', () => {
    const p = toZohoPayload(assembleBill(rows({ discountBeforeTax: false })), { discountAccountId: 'ACC-PURCH' });
    // 8% of 1180 = 94.4, plus a flat 15
    expect(p).toMatchObject({ discount: 109.4, discount_type: 'entity_level', is_discount_before_tax: false });
    expect(p.line_items.map(l => l.description)).toEqual(['Disc 8% after GST', 'Disc ₹15 after GST', undefined]);
    p.line_items.forEach(l => expect(l).not.toHaveProperty('discount'));
  });

  test('no row actually discounted: no discount fields and no account lookup', async () => {
    zohoPost.mockResolvedValue({ data: { bill: { bill_id: 'B1', bill_number: 'X', line_items: [] } } });
    await createBill(base({ discountLevel: 'line' }));
    expect(zohoPost.mock.calls[0][1]).not.toHaveProperty('discount_type');
    expect(zohoGet.mock.calls.some(c => c[0].includes('/chartofaccounts'))).toBe(false);
  });

  const zohoAfterTax = {
    bill_id: 'B7', bill_number: 'TN123', date: '2026-11-25', is_inclusive_tax: false,
    discount: 94.4, discount_amount: 94.4, discount_applied_on_amount: 1298, is_discount_before_tax: false,
    line_items: [
      { item_id: 'I1', rate: 100, quantity: 10, tax_percentage: 18 },
      { item_id: 'I2', rate: 100, quantity: 1, tax_percentage: 18 },
    ],
  };
  const afterTaxEntry = () => base({
    discountLevel: 'line', discountBeforeTax: false,
    lines: [
      { itemId: 'I1', quantity: 10, rate: 100, gstRate: 18, discount: 8 },
      { itemId: 'I2', quantity: 1, rate: 100, gstRate: 18 },
    ],
  });

  test('after GST: row figures are saved and history costs each item by its own', async () => {
    zohoPost.mockResolvedValue({ data: { bill: zohoAfterTax } });
    const out = await createBill(afterTaxEntry());
    expect(repo.saveRowDiscounts).toHaveBeenCalledWith(
      expect.objectContaining({ billId: 'B7', discountAmount: 94.4 }), null);
    const [entries] = repo.upsertMany.mock.calls[0];
    const cost = Object.fromEntries(entries.map(e => [e.itemId, e.rateIncl]));
    expect(cost).toEqual({ I1: 108.56, I2: 118 });     // not spread across both
    expect(out).not.toHaveProperty('warning');
  });

  test('if the record cannot be saved the bill still succeeds, and says so', async () => {
    zohoPost.mockResolvedValue({ data: { bill: zohoAfterTax } });
    repo.saveRowDiscounts.mockRejectedValueOnce(new Error('firestore down'));
    const out = await createBill(afterTaxEntry());
    expect(out).toMatchObject({ billId: 'B7', warning: expect.stringMatching(/spread/) });
  });

  test('before GST needs no record — Zoho holds each row', async () => {
    zohoPost.mockResolvedValue({ data: { bill: { bill_id: 'B8', bill_number: 'X', line_items: [] } } });
    await createBill(rows());
    expect(repo.saveRowDiscounts).not.toHaveBeenCalled();
  });
});
