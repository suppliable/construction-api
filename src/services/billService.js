'use strict';

// Vendor bill entry, pushed to Zoho Books.
//
// This exists for one reason: a purchase rate on a bill is EXCLUSIVE of GST
// while a selling price is INCLUSIVE, so comparing them by eye is comparing two
// different bases. A line at 63.94 against a selling price of 65 reads as
// margin; 63.94 + 18% = 75.45 does not. Across the 20 most recent bills, 16 of
// 71 item lines were at or above the selling price.
//
// The form therefore shows both on one basis as the rate is typed. It does NOT
// block: the agreed outcome is that whoever enters the bill raises the selling
// price, and a block that cannot name who overrode it (every admin shares one
// token) would be a control in name only.
//
// Zoho stays the system of record. This writes a bill and nothing more — no
// local bill store to drift out of step.

const { zohoPost, zohoGet } = require('./zohoHttp');
const { entriesFromBill, reduceToLatest, marginFor } = require('./purchaseHistoryService');
const repo = require('../repositories/purchaseHistoryRepository');
const { ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');

const BILLS_URL = 'https://www.zohoapis.in/books/v3/bills';
const ACCOUNTS_URL = 'https://www.zohoapis.in/books/v3/chartofaccounts';
const TAXES_URL = 'https://www.zohoapis.in/books/v3/settings/taxes';
const CONTACT_URL = 'https://www.zohoapis.in/books/v3/contacts';

// The org's own GST state. Tamil Nadu is 33; it decides whether a purchase is
// intra-state (CGST+SGST) or inter-state (IGST), so it is configurable rather
// than assumed.
const ORG_STATE_CODE = () => process.env.ZOHO_ORG_STATE_CODE || '33';

const round2 = n => Math.round(n * 100) / 100;
const str = v => (typeof v === 'string' ? v.trim() : '');

// Zoho stores one tax basis per bill, not per line, so the form's toggle is a
// bill-level choice. Entering the rates as printed — whichever basis the vendor
// used — keeps the bill total matching the paper document exactly; converting
// ourselves would drift by rounding paise and waste an afternoon at
// reconciliation.
const RATE_MODES = ['excl', 'incl'];
const DISCOUNT_LEVELS = ['bill', 'line'];

function assertDate(value, label) {
  const v = str(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new ValidationError(`${label} must be a date as YYYY-MM-DD`, 'INVALID_PARAM');
  }
  return v;
}

/**
 * One row's own discount, resolved to rupees and to a cost multiplier.
 *
 * Before GST, the figure comes off the row's TAXABLE value; after GST, off the
 * row's GST-inclusive total. A ₹ amount is for the whole row, not per unit.
 * Zoho does the same (verified against a live bill: a ₹15 row discount on a
 * GST-inclusive bill was taken from the taxable value, not the inclusive one),
 * so the bases here are computed the way Zoho computes them — from the line
 * total, not from a per-unit rate already rounded to paise.
 */
function rowDiscountFor(raw, { n, byRow, isInclusive, beforeTax, rate, quantity, gstRate }) {
  const none = { discountValue: 0, discountIsPercent: true, discountAmount: 0, costFactor: 1 };
  if (!byRow) return none;

  const value = Number(raw.discount) || 0;
  if (value < 0) throw new ValidationError(`Line ${n}: discount cannot be negative`, 'INVALID_PARAM');
  if (value === 0) return none;
  const isPercent = raw.discountIsPercent !== false;
  if (isPercent && value > 100) {
    throw new ValidationError(`Line ${n}: a percentage discount cannot exceed 100`, 'INVALID_PARAM');
  }

  const gross = rate * quantity;
  const g = 1 + gstRate / 100;
  const base = beforeTax
    ? round2(isInclusive ? gross / g : gross)
    : round2(isInclusive ? gross : gross * g);
  const amount = round2(isPercent ? (base * value) / 100 : value);
  if (amount > base) {
    throw new ValidationError(`Line ${n}: the discount is more than the line is worth`, 'INVALID_PARAM');
  }
  return {
    discountValue: value,
    discountIsPercent: isPercent,
    discountAmount: amount,
    costFactor: base > 0 ? 1 - amount / base : 1,
  };
}

/**
 * Validate and normalise a bill entry.
 *
 * Returns the shape Zoho expects plus the figures needed to show margins, so
 * the caller never has to recompute and risk the two disagreeing.
 */
function assembleBill(body = {}) {
  const vendorId = str(body.vendorId);
  if (!vendorId) throw new ValidationError('Select a vendor', 'MISSING_PARAM');

  const billNumber = str(body.billNumber);
  if (!billNumber) throw new ValidationError('Enter the vendor\'s bill number', 'MISSING_PARAM');

  const date = assertDate(body.date, 'Bill date');
  const dueDate = body.dueDate ? assertDate(body.dueDate, 'Due date') : null;

  const rateMode = str(body.rateMode) || 'excl';
  if (!RATE_MODES.includes(rateMode)) {
    throw new ValidationError(`rateMode must be one of: ${RATE_MODES.join(', ')}`, 'INVALID_PARAM');
  }
  const isInclusive = rateMode === 'incl';

  // A bill carries its discount EITHER as one figure for the whole bill OR row
  // by row, never both — that is how these vendors invoice, and Zoho has a
  // single discount level per bill.
  const discountLevel = str(body.discountLevel) || 'bill';
  if (!DISCOUNT_LEVELS.includes(discountLevel)) {
    throw new ValidationError(`discountLevel must be one of: ${DISCOUNT_LEVELS.join(', ')}`, 'INVALID_PARAM');
  }
  const byRow = discountLevel === 'line';
  const beforeTax = body.discountBeforeTax !== false;
  if (byRow && Number(body.discount) > 0) {
    throw new ValidationError('Use a discount on each row or on the whole bill, not both', 'INVALID_PARAM');
  }

  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  if (!rawLines.length) throw new ValidationError('Add at least one line', 'MISSING_PARAM');

  const lines = rawLines.map((l, i) => {
    const n = i + 1;
    const itemId = str(l.itemId);
    if (!itemId) throw new ValidationError(`Line ${n}: pick an item`, 'MISSING_PARAM');

    const quantity = Number(l.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new ValidationError(`Line ${n}: enter a quantity`, 'INVALID_PARAM');
    }
    const rate = Number(l.rate);
    if (!Number.isFinite(rate) || rate < 0) {
      throw new ValidationError(`Line ${n}: enter a rate`, 'INVALID_PARAM');
    }

    const gstRate = Number(l.gstRate) || 0;
    const rowDiscount = rowDiscountFor(l, { n, byRow, isInclusive, beforeTax, rate: round2(rate), quantity, gstRate });
    return {
      ...rowDiscount,
      itemId,
      name: str(l.name),
      quantity,
      rate: round2(rate),
      gstRate,
      unit: str(l.unit) || null,
      // Both bases, so a reader never has to know which one was typed.
      rateExcl: round2(isInclusive ? rate / (1 + gstRate / 100) : rate),
      rateIncl: round2(isInclusive ? rate : rate * (1 + gstRate / 100)),
    };
  });

  // A bill-level discount, matching how the vendors here actually issue them:
  // a percentage off the whole bill, sometimes before tax and sometimes after.
  // Per-unit cost is identical either way (multiplication commutes) but the GST
  // differs, so Zoho still needs to be told which it was.
  const discountValue = Number(body.discount) || 0;
  if (discountValue < 0) throw new ValidationError('Discount cannot be negative', 'INVALID_PARAM');
  const discountIsPercent = body.discountIsPercent !== false;
  if (discountIsPercent && discountValue > 100) {
    throw new ValidationError('A percentage discount cannot exceed 100', 'INVALID_PARAM');
  }

  return {
    vendorId,
    billNumber,
    date,
    dueDate,
    rateMode,
    isInclusive,
    lines,
    discountValue,
    discountIsPercent,
    discountBeforeTax: beforeTax,
    discountLevel,
    notes: str(body.notes) || null,
  };
}

/** What the bill comes to, mirroring how Zoho will compute it. */
function billTotals(bill) {
  const taxable = round2(bill.lines.reduce((s, l) => s + l.rateExcl * l.quantity, 0));
  const grossIncl = round2(bill.lines.reduce((s, l) => s + l.rateIncl * l.quantity, 0));
  const tax = round2(grossIncl - taxable);

  if (bill.discountLevel === 'line') {
    const discount = round2(bill.lines.reduce((s, l) => s + l.discountAmount, 0));
    // Before tax each row's GST follows its own discounted value, so it is
    // summed row by row; after tax the discount simply comes off the total.
    const total = bill.discountBeforeTax
      ? round2(bill.lines.reduce((s, l) => {
        const gross = l.rate * l.quantity;
        const net = (bill.isInclusive ? gross / (1 + l.gstRate / 100) : gross) - l.discountAmount;
        return s + net * (1 + l.gstRate / 100);
      }, 0))
      // From line totals, not the per-unit inclusive rate: rounding that to
      // paise first and multiplying drifts by up to tens of paise on a bill.
      : round2(bill.lines.reduce((s, l) => {
        const gross = l.rate * l.quantity;
        return s + (bill.isInclusive ? gross : gross * (1 + l.gstRate / 100));
      }, 0) - discount);
    return { taxable, tax, grossIncl, discount, total, discountBase: bill.discountBeforeTax ? taxable : grossIncl };
  }

  const base = bill.discountBeforeTax ? taxable : grossIncl;
  const discount = bill.discountValue <= 0
    ? 0
    : round2(bill.discountIsPercent ? (base * bill.discountValue) / 100 : bill.discountValue);

  // Before tax, the discount reduces the taxable value and so the tax with it;
  // after tax it comes off the total. Computed rather than assumed, because the
  // two give different GST even though the cash is the same.
  const taxableAfter = bill.discountBeforeTax ? round2(taxable - discount) : taxable;
  const taxAfter = bill.discountBeforeTax
    ? round2(taxableAfter * (taxable > 0 ? tax / taxable : 0))
    : tax;
  const total = bill.discountBeforeTax
    ? round2(taxableAfter + taxAfter)
    : round2(grossIncl - discount);

  return { taxable, tax, grossIncl, discount, total, discountBase: base };
}

/**
 * Per-line cost against selling price, on one basis.
 *
 * `itemsById` carries the selling price from the catalogue. A line whose item
 * is unknown gets a null margin rather than a wrong one.
 */
function lineMargins(bill, itemsById = new Map()) {
  const { discountBase, discount } = billTotals(bill);
  // A whole-bill discount applies pro-rata, so one factor serves every line.
  const billFactor = discountBase > 0 && discount > 0 ? 1 - discount / discountBase : 1;

  return bill.lines.map((l) => {
    const item = itemsById.get(String(l.itemId));
    // Row discounts belong to their own row; only a whole-bill discount spreads.
    const costIncl = round2(l.rateIncl * (bill.discountLevel === 'line' ? l.costFactor : billFactor));
    const m = marginFor({ rate: item?.sellingRate ?? 0 }, { rateIncl: costIncl });
    return {
      itemId: l.itemId,
      name: l.name || item?.name || '',
      quantity: l.quantity,
      rateExcl: l.rateExcl,
      rateIncl: l.rateIncl,
      costIncl,
      sellingIncl: m.sellIncl,
      marginPct: m.marginPct,
      status: m.status,
    };
  });
}

// Zoho refuses a discounted bill without an account to post the discount to:
// "Associate an account for discount." It must be the PURCHASE discount
// account (expense) — the similarly named "Discount" account is income, for
// reductions given on sales, and posting a vendor discount there would land it
// on the wrong side of the P&L.
//
// Resolved once and cached: it is one row in the chart of accounts and never
// changes. ZOHO_PURCHASE_DISCOUNT_ACCOUNT_ID pins it explicitly; without that
// it is looked up by name, so a discounted bill works with no configuration.
let discountAccountId = null;

async function purchaseDiscountAccountId() {
  if (process.env.ZOHO_PURCHASE_DISCOUNT_ACCOUNT_ID) {
    return process.env.ZOHO_PURCHASE_DISCOUNT_ACCOUNT_ID;
  }
  if (discountAccountId) return discountAccountId;

  const res = await zohoGet(ACCOUNTS_URL, {
    params: { search_text: 'discount', filter_by: 'AccountType.Expense' },
    label: 'zoho.api.listDiscountAccounts',
  });
  const accounts = (res.data?.chartofaccounts || []).filter(a => a.is_active !== false);
  const match = accounts.find(a => /purchase\s*discount/i.test(a.account_name || ''))
    || accounts.find(a => /discount/i.test(a.account_name || ''));

  if (!match) {
    throw new ValidationError(
      'No purchase discount account exists in Zoho. Create an expense account named '
        + '"Purchase Discounts", or set ZOHO_PURCHASE_DISCOUNT_ACCOUNT_ID.',
      'NO_DISCOUNT_ACCOUNT'
    );
  }
  discountAccountId = match.account_id;
  logger.info({ accountId: match.account_id, name: match.account_name },
    'bill.discount_account.resolved');
  return discountAccountId;
}

// Zoho will not accept a bill line without a tax: "Specify either a Tax or Tax
// Exemption or Reverse Charge." It does not fall back to the item's own tax
// preference, so the tax id has to be sent explicitly.
//
// The org has two families, and which one applies is not a free choice — it is
// decided by where the vendor is. A Tamil Nadu vendor charges CGST+SGST (the
// "intra" tax GROUPS, GST0..GST40); anyone else charges IGST (the "inter"
// taxes). Sending the wrong family would post a bill whose tax split does not
// match the vendor's document.
let taxCache = null;

async function loadTaxes() {
  if (taxCache) return taxCache;
  const res = await zohoGet(TAXES_URL, { label: 'zoho.api.listTaxes' });
  taxCache = (res.data?.taxes || []).filter(t => !t.is_inactive);
  return taxCache;
}

/** Tax id for a GST percentage, in the family the vendor's location requires. */
async function taxIdFor(gstRate, specification) {
  const taxes = await loadTaxes();
  const pct = Number(gstRate) || 0;
  const match = taxes.find(t =>
    Number(t.tax_percentage) === pct && t.tax_specification === specification);

  if (!match) {
    throw new ValidationError(
      `No ${specification === 'inter' ? 'IGST' : 'GST'} tax of ${pct}% exists in Zoho. `
        + 'Create it there, or correct the GST % on the line.',
      'NO_MATCHING_TAX'
    );
  }
  return match.tax_id;
}

/**
 * intra or inter, from the vendor's own GSTIN.
 *
 * A vendor with no GSTIN is treated as local: an unregistered supplier here is
 * a neighbourhood one, and IGST on a local purchase would be plainly wrong.
 */
async function vendorTaxSpecification(vendorId) {
  const res = await zohoGet(`${CONTACT_URL}/${vendorId}`, { label: 'zoho.api.getVendor' });
  const gstin = String(res.data?.contact?.gst_no || '').trim();
  if (gstin.length < 2) return 'intra';
  return gstin.slice(0, 2) === ORG_STATE_CODE() ? 'intra' : 'inter';
}

/** "Disc 8% after GST" — so the row's discount can be read on the bill in Zoho. */
function rowDiscountNote(l) {
  return `Disc ${l.discountIsPercent ? `${l.discountValue}%` : `₹${l.discountValue}`} after GST`;
}

/** Payload for POST /books/v3/bills. */
function toZohoPayload(bill, { discountAccountId: accountId = null, taxIds = null } = {}) {
  const byRow = bill.discountLevel === 'line';
  const rowTotal = byRow ? round2(bill.lines.reduce((s, l) => s + l.discountAmount, 0)) : 0;
  // Row discounts before GST are Zoho's own item-level discount. After GST it
  // has no such thing (an item discount always reduces the taxable value), so
  // they go as ONE after-tax figure on the bill, which keeps GST and total
  // matching the vendor's invoice.
  const nativeRows = byRow && bill.discountBeforeTax && rowTotal > 0;
  const rolledUpRows = byRow && !bill.discountBeforeTax && rowTotal > 0;

  const payload = {
    vendor_id: bill.vendorId,
    bill_number: bill.billNumber,
    date: bill.date,
    is_inclusive_tax: bill.isInclusive,
    line_items: bill.lines.map(l => ({
      item_id: l.itemId,
      ...(taxIds?.get(String(l.gstRate)) ? { tax_id: taxIds.get(String(l.gstRate)) } : {}),
      // Rate as typed — Zoho reads it on the basis is_inclusive_tax declares,
      // so the bill total matches the vendor's document to the paisa.
      rate: l.rate,
      quantity: l.quantity,
      ...(nativeRows && l.discountValue > 0
        ? { discount: l.discountIsPercent ? `${l.discountValue}%` : l.discountValue }
        : {}),
      ...(rolledUpRows && l.discountValue > 0 ? { description: rowDiscountNote(l) } : {}),
      // `unit` is deliberately NOT sent. Zoho takes it from the item, and a
      // value that does not match a unit configured in the org is rejected —
      // the catalogue's unit string is free text ("box", "Pcs"), so sending it
      // can only ever fail, never help.
    })),
  };
  if (bill.dueDate) payload.due_date = bill.dueDate;
  if (bill.notes) payload.notes = bill.notes;

  if (nativeRows) {
    payload.discount_type = 'item_level';
    payload.is_discount_before_tax = true;
  } else if (rolledUpRows) {
    payload.discount = rowTotal;
    payload.discount_type = 'entity_level';
    payload.is_discount_before_tax = false;
  } else if (bill.discountValue > 0) {
    payload.discount = bill.discountIsPercent ? `${bill.discountValue}%` : bill.discountValue;
    payload.discount_type = 'entity_level';
    payload.is_discount_before_tax = bill.discountBeforeTax;
  }
  if (accountId && payload.discount_type) payload.discount_account_id = accountId;
  return payload;
}

/**
 * What the purchase history needs to remember about after-GST row discounts.
 * Zoho only holds their sum, and spreading that evenly would give every item the
 * wrong cost. Null when Zoho's own record is already enough.
 */
function rowDiscountRecord(bill, billId) {
  if (bill.discountLevel !== 'line' || bill.discountBeforeTax) return null;
  const discountAmount = round2(bill.lines.reduce((s, l) => s + l.discountAmount, 0));
  if (discountAmount <= 0) return null;
  return {
    billId: String(billId),
    billNumber: bill.billNumber,
    discountAmount,
    lines: bill.lines.map(l => ({
      itemId: String(l.itemId), quantity: l.quantity, rate: l.rate,
      discountValue: l.discountValue, discountIsPercent: l.discountIsPercent,
      factor: l.costFactor,
    })),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Create the bill in Zoho and fold it straight into purchase history.
 *
 * History is updated from Zoho's OWN response rather than from the submitted
 * form, so what the margin report shows is what Zoho actually recorded —
 * including any rounding or discount handling Zoho applied itself.
 */
async function createBill(body, traceContext = null) {
  const bill = assembleBill(body);
  // Only looked up when there is a discount, so an undiscounted bill costs no
  // extra Zoho call.
  const accountId = billTotals(bill).discount > 0 ? await purchaseDiscountAccountId() : null;

  // One lookup per distinct GST rate on the bill, not per line.
  const specification = await vendorTaxSpecification(bill.vendorId);
  const taxIds = new Map();
  for (const rate of new Set(bill.lines.map(l => String(l.gstRate)))) {
    taxIds.set(rate, await taxIdFor(rate, specification));
  }

  const payload = toZohoPayload(bill, { discountAccountId: accountId, taxIds });

  let res;
  try {
    res = await zohoPost(BILLS_URL, payload);
  } catch (err) {
    // Carry the payload on the error so the handler can log exactly what Zoho
    // refused. Without it the log says "invalid value" and names no field.
    err.zohoPayload = payload;
    throw err;
  }
  const created = res.data?.bill;
  if (!created) throw new ValidationError('Zoho did not return a bill', 'ZOHO_NO_BILL');

  // After-GST row discounts: remember them BEFORE touching history, so both
  // this write and every later sync cost each item correctly.
  let warning = null;
  const rows = rowDiscountRecord(bill, created.bill_id);
  if (rows) {
    try {
      await repo.saveRowDiscounts(rows, traceContext);
    } catch (err) {
      logger.error({ err: err.message, billId: created.bill_id }, 'bill.row_discounts_save_failed');
      warning = 'Saved in Zoho, but the row discounts could not be recorded: '
        + 'the Margins page will spread this bill\'s discount evenly across its items.';
    }
  }

  // Best-effort: the bill exists in Zoho either way, and the hourly sync would
  // pick it up regardless. Failing here must not look like the bill failed.
  try {
    await repo.upsertMany(reduceToLatest(entriesFromBill(created, rows)), traceContext);
  } catch (err) {
    logger.warn({ err: err.message, billId: created.bill_id },
      'bill.history_update_failed');
  }

  logger.info({ billId: created.bill_id, billNumber: created.bill_number, total: created.total },
    'bill.created');

  return {
    billId: created.bill_id,
    billNumber: created.bill_number,
    date: created.date,
    total: created.total,
    vendorName: created.vendor_name,
    ...(warning ? { warning } : {}),
  };
}

module.exports = {
  assembleBill,
  purchaseDiscountAccountId,
  taxIdFor,
  vendorTaxSpecification,
  // The resolved account is cached for the process lifetime; tests need to
  // clear it to prove the lookup itself picks the right one.
  _resetDiscountAccountCache: () => { discountAccountId = null; taxCache = null; },
  billTotals,
  lineMargins,
  toZohoPayload,
  createBill,
  RATE_MODES,
};
