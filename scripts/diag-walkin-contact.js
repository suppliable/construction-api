'use strict';

// Diagnostic: find the real walk-in contact in Zoho and test reliable lookups.
// Run: node scripts/diag-walkin-contact.js
require('dotenv').config();
const axios = require('axios');

async function token() {
  const r = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: {
      grant_type: 'refresh_token',
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    },
    timeout: 20000,
  });
  return r.data.access_token;
}

async function listContacts(t, params) {
  const r = await axios.get(`${process.env.ZOHO_API_DOMAIN}/books/v3/contacts`, {
    headers: { Authorization: `Zoho-oauthtoken ${t}` },
    params: { organization_id: process.env.ZOHO_ORG_ID, contact_type: 'customer', ...params },
    timeout: 20000,
  });
  return { contacts: r.data.contacts || [], hasMore: r.data.page_context?.has_more_page };
}

(async () => {
  const t = await token();

  // 1) Ground truth: paginate ALL customers, find any containing "walk".
  let page = 1, all = [];
  while (true) {
    const { contacts, hasMore } = await listContacts(t, { per_page: 200, page });
    all.push(...contacts);
    if (!hasMore) break;
    page++;
  }
  const walk = all.filter(c => /walk/i.test(c.contact_name || ''));
  console.log(`Total customers: ${all.length}`);
  console.log(`Contacts containing "walk":`);
  walk.forEach(c => console.log(`  - "${c.contact_name}"  (id ${c.contact_id})`));

  // 2) Test which server-side filter reliably returns it.
  for (const params of [
    { search_text: 'Walk-in Customer' },
    { search_text: 'Walk-in' },
    { contact_name_contains: 'Walk' },
    { contact_name_startswith: 'Walk-in Customer' },
  ]) {
    const { contacts } = await listContacts(t, params);
    const hit = contacts.filter(c => /walk/i.test(c.contact_name || ''));
    console.log(`\nfilter ${JSON.stringify(params)} → ${contacts.length} results, ${hit.length} walk-matches`);
    hit.slice(0, 3).forEach(c => console.log(`    "${c.contact_name}"`));
  }
  process.exit(0);
})().catch(e => { console.error('DIAG ERROR:', e.response?.status, e.response?.data ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
