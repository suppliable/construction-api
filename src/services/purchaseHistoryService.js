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

/** Flatten one Zoho bill into one history entry per item line. */
function entriesFromBill(bill) {
  const inclusive = bill.is_inclusive_tax === true;
  const out = [];
  for (const li of bill.line_items || []) {
    // Freight, loading and discount lines carry no item_id; there is nothing to
    // compare them against, so they are not purchase history.
    if (!li.item_id) continue;
    const gstRate = Number(li.tax_percentage) || 0;
    out.push({
      itemId: String(li.item_id),
      name: li.name || '',
      lastBillId: String(bill.bill_id),
      lastBillNumber: bill.bill_number || '',
      lastDate: bill.date || '',
      quantity: Number(li.quantity) || 0,
      gstRate,
      rateExcl: inclusive ? round2((Number(li.rate) || 0) / (1 + gstRate / 100)) : round2(Number(li.rate) || 0),
      rateIncl: toInclusive(li.rate, gstRate, inclusive),
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
async function syncFromBills({ full = false } = {}, traceContext = null) {
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
  const written = await repo.upsertMany(latest, traceContext);

  const newWatermark = bills.reduce(
    (max, b) => (String(b.last_modified_time || '') > String(max) ? b.last_modified_time : max),
    watermark || ''
  );
  if (newWatermark) {
    await repo.setWatermark(newWatermark, { billsScanned: bills.length, billsChanged: changed.length, itemsWritten: written }, traceContext);
  }

  logger.info({ billsScanned: bills.length, billsChanged: changed.length, itemsWritten: written, full },
    'purchase_history.synced');
  return { billsScanned: bills.length, billsChanged: changed.length, itemsWritten: written };
}

module.exports = {
  syncFromBills,
  marginFor,
  entriesFromBill,
  reduceToLatest,
  toInclusive,
};
