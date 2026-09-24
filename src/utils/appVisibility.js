'use strict';

// App visibility: a product shows in the customer app unless its Zoho item has
// the `cf_walkin` checkbox ticked (walk-in / counter-only). Missing / false /
// empty all mean visible — so every existing product is app-listed by default
// and only explicitly-ticked items are hidden. Hidden items remain billable at
// the counter (the POS reads them by id). Mirrors the dual raw-field /
// custom_field_hash read used for other custom fields (cf_rack_number, ...).
//
// NOTE: create the Zoho field with label "walkin" (no cf_ prefix) so its
// api_name resolves to `cf_walkin` — labelling it "cf_walkin" would double-
// prefix to `cf_cf_walkin`.
function isWalkinOnly(item) {
  const v = item?.cf_walkin ?? item?.custom_field_hash?.cf_walkin;
  return v === true || v === 'true';
}

function isAppVisible(item) {
  return !isWalkinOnly(item);
}

// Bulk orders: an item is offered in the Bulk catalogue when its Zoho item has
// the `cf_bulk` checkbox ticked. Same shape as cf_walkin above, and the same
// labelling caveat — create the Zoho field with label "bulk", not "cf_bulk".
//
// Sourcing bulk from Zoho rather than a separate list means GST, HSN, rate and
// units are the ones finance already maintains, and an order placed against a
// bulk item can raise a Zoho SO like any other, because the item_id is real.
function isBulkItem(item) {
  const v = item?.cf_bulk ?? item?.custom_field_hash?.cf_bulk;
  return v === true || v === 'true';
}

module.exports = { isAppVisible, isWalkinOnly, isBulkItem };
