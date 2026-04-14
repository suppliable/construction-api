const axios = require('axios');

let accessToken = null;
let tokenExpiry = null;

async function getAccessToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    return accessToken;
  }
  const response = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: {
      grant_type: 'refresh_token',
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN
    }
  });
  accessToken = response.data.access_token;
  tokenExpiry = Date.now() + (55 * 60 * 1000);
  return accessToken;
}

async function getZohoProducts() {
  const token = await getAccessToken();
  const response = await axios.get(`${process.env.ZOHO_API_DOMAIN}/inventory/v1/items`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: process.env.ZOHO_ORG_ID }
  });
  return response.data.items;
}

async function getZohoProductById(itemId) {
  const token = await getAccessToken();
  const response = await axios.get(`${process.env.ZOHO_API_DOMAIN}/inventory/v1/items/${itemId}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: process.env.ZOHO_ORG_ID }
  });
  return response.data.item;
}

async function getZohoItemGroups() {
  const token = await getAccessToken();
  const response = await axios.get(`${process.env.ZOHO_API_DOMAIN}/inventory/v1/itemgroups`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: process.env.ZOHO_ORG_ID }
  });
  return response.data.itemgroups;
}

async function getZohoItemGroupById(groupId) {
  const token = await getAccessToken();
  const response = await axios.get(`${process.env.ZOHO_API_DOMAIN}/inventory/v1/itemgroups/${groupId}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: process.env.ZOHO_ORG_ID }
  });
  return response.data.item_group;
}

async function createZohoContact(contactData) {
  const token = await getAccessToken();
  const response = await axios.post('https://www.zohoapis.in/books/v3/contacts', {
    contact_name: contactData.business_name || contactData.name || contactData.phone,
    company_name: contactData.business_name || contactData.name || contactData.phone,
    contact_type: 'customer',
    gst_treatment: contactData.is_business ? 'business_gst' : 'consumer',
    gst_no: contactData.gstin || '',
    place_of_contact: contactData.registered_address?.state_code || 'TN',
    contact_persons: [
      {
        first_name: contactData.name || contactData.phone,
        last_name: '',
        mobile: contactData.phone,
        is_primary_contact: true
      }
    ],
    billing_address: contactData.registered_address ? {
      attention: contactData.business_name || contactData.name || '',
      address: contactData.registered_address.address_line1 || '',
      street2: contactData.registered_address.address_line2 || '',
      city: contactData.registered_address.city || '',
      state: contactData.registered_address.state || '',
      zip: contactData.registered_address.pincode || '',
      country: 'India'
    } : {}
  }, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: process.env.ZOHO_ORG_ID }
  });
  return response.data.contact;
}

module.exports = {
  getAccessToken,
  getZohoProducts,
  getZohoProductById,
  getZohoItemGroups,
  getZohoItemGroupById,
  createZohoContact
};
