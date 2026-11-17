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

const { zohoPost } = require('./zohoHttp');
const { entriesFromBill, reduceToLatest, marginFor } = require('./purchaseHistoryService');
const repo = require('../repositories/purchaseHistoryRepository');
const { ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');

const BILLS_URL = 'https://www.zohoapis.in/books/v3/bills';

const round2 = n => Math.round(n * 100) / 100;
const str = v => (typeof v === 'string' ? v.trim() : '');

// Zoho stores one tax basis per bill, not per line, so the form's toggle is a
// bill-level choice. Entering the rates as printed — whichever basis the vendor
// used — keeps the bill total matching the paper document exactly; converting
// ourselves would drift by rounding paise and waste an afternoon at
// reconciliation.
const RATE_MODES = ['excl', 'incl'];

function assertDate(value, label) {
  const v = str(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new ValidationError(`${label} must be a date as YYYY-MM-DD`, 'INVALID_PARAM');
  }
  return v;
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
    return {
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
    discountBeforeTax: body.discountBeforeTax !== false,
    notes: str(body.notes) || null,
  };
}

/** What the bill comes to, mirroring how Zoho will compute it. */
function billTotals(bill) {
  const taxable = round2(bill.lines.reduce((s, l) => s + l.rateExcl * l.quantity, 0));
  const grossIncl = round2(bill.lines.reduce((s, l) => s + l.rateIncl * l.quantity, 0));
  const tax = round2(grossIncl - taxable);

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
  // The discount applies pro-rata, so one factor serves every line.
  const factor = discountBase > 0 && discount > 0 ? 1 - discount / discountBase : 1;

  return bill.lines.map((l) => {
    const item = itemsById.get(String(l.itemId));
    const costIncl = round2(l.rateIncl * factor);
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

/** Payload for POST /books/v3/bills. */
function toZohoPayload(bill) {
  const payload = {
    vendor_id: bill.vendorId,
    bill_number: bill.billNumber,
    date: bill.date,
    is_inclusive_tax: bill.isInclusive,
    line_items: bill.lines.map(l => ({
      item_id: l.itemId,
      // Rate as typed — Zoho reads it on the basis is_inclusive_tax declares,
      // so the bill total matches the vendor's document to the paisa.
      rate: l.rate,
      quantity: l.quantity,
      // `unit` is deliberately NOT sent. Zoho takes it from the item, and a
      // value that does not match a unit configured in the org is rejected —
      // the catalogue's unit string is free text ("box", "Pcs"), so sending it
      // can only ever fail, never help.
    })),
  };
  if (bill.dueDate) payload.due_date = bill.dueDate;
  if (bill.notes) payload.notes = bill.notes;
  if (bill.discountValue > 0) {
    payload.discount = bill.discountIsPercent ? `${bill.discountValue}%` : bill.discountValue;
    payload.discount_type = 'entity_level';
    payload.is_discount_before_tax = bill.discountBeforeTax;
  }
  return payload;
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
  const payload = toZohoPayload(bill);

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

  // Best-effort: the bill exists in Zoho either way, and the hourly sync would
  // pick it up regardless. Failing here must not look like the bill failed.
  try {
    await repo.upsertMany(reduceToLatest(entriesFromBill(created)), traceContext);
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
  };
}

module.exports = {
  assembleBill,
  billTotals,
  lineMargins,
  toZohoPayload,
  createBill,
  RATE_MODES,
};
