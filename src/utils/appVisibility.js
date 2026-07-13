'use strict';

// App visibility (opt-out): a product shows in the customer app unless its Zoho
// item has cf_app_visible explicitly set to false. Missing / true / empty all
// mean visible. Hidden items remain billable at the counter (the POS reads them
// by id). Mirrors the dual raw-field / custom_field_hash read used for other
// custom fields (cf_rack_number, cf_tintable, ...).
function isAppVisible(item) {
  const v = item?.cf_app_visible ?? item?.custom_field_hash?.cf_app_visible;
  return !(v === false || v === 'false');
}

module.exports = { isAppVisible };
