'use strict';

// Last-purchase tracking and margin comparison.
//
// WHY THIS EXISTS: bills are recorded EXCLUSIVE of GST (every one of the 241 in
// the org has is_inclusive_tax false) while selling prices are stored INCLUSIVE.
// So a buyer comparing the number on the bill against the selling price is
// comparing two different bases — a line at 63.94 against a selling price of 65
// looks like margin, but 63.94 + 18% = 75.45 is 16% underwater. Measured across
// the 20 most recent bills, 16 of 71 item lines were at or above the selling
// price. The fix is to make the comparison visible, in one basis.
//
// Everything here normalises to GST-INCLUSIVE, because that is the only basis
// in which "what we paid" and "what we charge" are the same kind of number.

const { zohoGet } = require('./zohoHttp');
const repo = require('../repositories/purchaseHistoryRepository');
const logger = require('../utils/logger');

const BILLS_URL = 'https://www.zohoapis.in/books/v3/bills';

const round2 = n => Math.round(n * 100) / 100;

/** Per-unit price including GST — the only figure comparable to a selling price. */
function toInclusive(rate, gstRate, isInclusiveTax) {
  const r = Number(rate) || 0;
  if (isInclusiveTax) return round2(r);
  return round2(r * (1 + (Number(gstRate) || 0) / 100));
}

/**
 * Compare what an item was last bought for against what it sells for.
 *
 * `status` is the thing a reader acts on:
 *   underwater  — bought at or above the selling price; margin is zero or negative
 *   no_purchase — never billed, so nothing to compare
 *   no_price    — no selling price set, so margin is undefined (not zero)
 */
function marginFor(item, history) {
  const sellIncl = Number(item?.rate) || 0;
  const buyIncl = history ? Number(history.rateIncl) || 0 : null;

  if (!sellIncl) return { status: 'no_price', sellIncl: 0, buyIncl, marginPct: null, marginValue: null };
  if (buyIncl === null || buyIncl === 0) {
    return { status: 'no_purchase', sellIncl, buyIncl: null, marginPct: null, marginValue: null };
  }

  const marginValue = round2(sellIncl - buyIncl);
  const marginPct = round2((marginValue / sellIncl) * 100);
  return {
    status: buyIncl >= sellIncl ? 'underwater' : 'ok',
    sellIncl,
    buyIncl,
    marginValue,
    marginPct,
  };
}

/**
 * How much of a bill's face value is actually payable, as a multiplier.
 *
 * Bills here carry a bill-level ("entity_level") discount, sometimes applied
 * BEFORE tax and sometimes AFTER — e.g. 5% off 9,320 taxable, versus 8% off
 * 53,299.42 tax-inclusive. That distinction looks like it should need two code
 * paths, and it does not:
 *
 *     pre:   rate x (1 - d) x (1 + gst)
 *     post:  rate x (1 + gst) x (1 - d)
 *
 * Multiplication commutes, so the per-unit INCLUSIVE cost is identical either
 * way. Where before/after genuinely matters is the GST amount, and so the input
 * tax credit — not what the stock cost. This function therefore returns a
 * single factor for both.
 *
 * Zoho reports `discount_applied_on_amount`, the base it actually computed
 * against, which keeps the same formula correct for a FLAT discount too: a
 * fixed ₹500 off a taxable base is a different percentage from ₹500 off an
 * inclusive base, and dividing by Zoho's own base handles that without us
 * having to decide which it was.
 *
 * `adjustment` (the rounding line, -22.47 on a 49,013 bill) is deliberately
 * ignored: it is 0.05%, and it belongs to the bill rather than to any line, so
 * there is no honest way to attribute it per item.
 */
function billDiscountFactor(bill) {
  const raw = bill?.discount;
  if (raw === undefined || raw === null || raw === '' || raw === 0) return 1;

  // Zoho sends a percentage as a string ("8.00%") and a flat discount as a number.
  const asString = String(raw).trim();
  if (asString.endsWith('%')) {
    const pct = parseFloat(asString);
    if (!Number.isFinite(pct) || pct <= 0) return 1;
    return 1 - pct / 100;
  }

  const amount = Number(raw);
  const base = Number(bill.discount_applied_on_amount) || 0;
  if (!Number.isFinite(amount) || amount <= 0 || base <= 0) return 1;
  return 1 - amount / base;
}

/** A line's own discount, if the vendor itemised it rather than discounting the bill. */
function lineDiscountFactor(li) {
  const amount = Number(li?.discount_amount) || 0;
  const gross = (Number(li?.rate) || 0) * (Number(li?.quantity) || 0);
  if (amount > 0 && gross > 0) return 1 - amount / gross;

  const raw = li?.discount;
  if (raw === undefined || raw === null || raw === '' || raw === 0) return 1;
  const pct = parseFloat(String(raw));
  if (!Number.isFinite(pct) || pct <= 0) return 1;
  return 1 - pct / 100;
}

/** Flatten one Zoho bill into one history entry per item line. */
function entriesFromBill(bill) {
  const inclusive = bill.is_inclusive_tax === true;
  const billFactor = billDiscountFactor(bill);
  const out = [];
  for (const li of bill.line_items || []) {
    // Freight, loading and discount lines carry no item_id; there is nothing to
    // compare them against, so they are not purchase history.
    if (!li.item_id) continue;
    const gstRate = Number(li.tax_percentage) || 0;
    const factor = billFactor * lineDiscountFactor(li);
    const grossIncl = toInclusive(li.rate, gstRate, inclusive);
    const grossExcl = inclusive
      ? round2((Number(li.rate) || 0) / (1 + gstRate / 100))
      : round2(Number(li.rate) || 0);
    out.push({
      itemId: String(li.item_id),
      name: li.name || '',
      lastBillId: String(bill.bill_id),
      lastBillNumber: bill.bill_number || '',
      lastDate: bill.date || '',
      quantity: Number(li.quantity) || 0,
      gstRate,
      // Net of discount — what the stock actually cost, and the only figure
      // worth comparing with a selling price.
      rateExcl: round2(grossExcl * factor),
      rateIncl: round2(grossIncl * factor),
      // Kept so the report can show WHY a cost differs from the printed rate;
      // without it a discounted line looks like a data error.
      grossRateIncl: grossIncl,
      discountPct: factor === 1 ? 0 : round2((1 - factor) * 100),
      vendorId: bill.vendor_id || null,
      vendorName: bill.vendor_name || '',
      updatedAt: new Date().toISOString(),
    });
  }
  return out;
}

/** Keep only the newest line per item, so one upsert wins per document. */
function reduceToLatest(entries) {
  const byItem = new Map();
  for (const e of entries) {
    const prev = byItem.get(e.itemId);
    // String date compare is safe: Zoho returns ISO yyyy-mm-dd.
    if (!prev || String(e.lastDate) >= String(prev.lastDate)) byItem.set(e.itemId, e);
  }
  return [...byItem.values()];
}

async function listAllBills() {
  const all = [];
  let page = 1;
  for (;;) {
    // Sequential: paging is inherently so.
    const res = await zohoGet(BILLS_URL, {
      params: { per_page: 200, page },
      label: 'zoho.api.listBills',
    });
    all.push(...(res.data.bills || []));
    if (!res.data.page_context?.has_more_page) break;
    page += 1;
  }
  return all;
}

/**
 * Refresh purchase history from Zoho.
 *
 * Only bills modified since the last run have their detail fetched — the list
 * itself is two calls, the details are one call each. A first run (or `full`)
 * walks every bill, which is why the backfill is a script rather than something
 * a page load can trigger.
 */
async function syncFromBills({ full = false, dryRun = false } = {}, traceContext = null) {
  const watermark = full ? null : await repo.getWatermark(traceContext);
  const bills = await listAllBills();

  const changed = watermark
    ? bills.filter(b => String(b.last_modified_time || '') > String(watermark))
    : bills;

  // Oldest first, so that when two bills touch the same item the newer one is
  // written last and reduceToLatest still resolves ties by bill date.
  changed.sort((a, b) => String(a.last_modified_time || '').localeCompare(String(b.last_modified_time || '')));

  const entries = [];
  for (const row of changed) {
    // Serial on purpose: Zoho rate-limits, and a full walk is ~241 calls.
    const res = await zohoGet(`${BILLS_URL}/${row.bill_id}`, { label: 'zoho.api.getBill' });
    entries.push(...entriesFromBill(res.data.bill || {}));
  }

  const latest = reduceToLatest(entries);
  // A dry run proves the Zoho side end-to-end — paging, detail fetches, the
  // inclusive conversion — without touching Firestore, so the target project
  // can be confirmed before anything is persisted.
  const written = dryRun ? 0 : await repo.upsertMany(latest, traceContext);

  const newWatermark = bills.reduce(
    (max, b) => (String(b.last_modified_time || '') > String(max) ? b.last_modified_time : max),
    watermark || ''
  );
  if (newWatermark && !dryRun) {
    await repo.setWatermark(newWatermark, { billsScanned: bills.length, billsChanged: changed.length, itemsWritten: written }, traceContext);
  }

  logger.info({ billsScanned: bills.length, billsChanged: changed.length, itemsWritten: written, full, dryRun },
    'purchase_history.synced');
  return {
    billsScanned: bills.length,
    billsChanged: changed.length,
    itemsWritten: written,
    ...(dryRun ? { itemsWouldWrite: latest.length, dryRun: true } : {}),
  };
}

module.exports = {
  syncFromBills,
  billDiscountFactor,
  lineDiscountFactor,
  marginFor,
  entriesFromBill,
  reduceToLatest,
  toInclusive,
};
