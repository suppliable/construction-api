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
  const allItems = [];
  let page = 1;
  while (true) {
    const response = await axios.get(`${process.env.ZOHO_API_DOMAIN}/inventory/v1/items`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: process.env.ZOHO_ORG_ID, per_page: 200, page }
    });
    const items = response.data.items || [];
    allItems.push(...items);
    if (!response.data.page_context?.has_more_page) break;
    page++;
  }
  return allItems;
}

async function getZohoCategories() {
  const token = await getAccessToken();
  const response = await axios.get(`${process.env.ZOHO_API_DOMAIN}/inventory/v1/categories`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: process.env.ZOHO_ORG_ID }
  });
  return (response.data.categories || []).filter(c => c.category_id !== '-1');
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
  const allGroups = [];
  let page = 1;
  while (true) {
    const response = await axios.get(`${process.env.ZOHO_API_DOMAIN}/inventory/v1/itemgroups`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: process.env.ZOHO_ORG_ID, per_page: 200, page }
    });
    const groups = response.data.itemgroups || [];
    allGroups.push(...groups);
    if (!response.data.page_context?.has_more_page) break;
    page++;
  }
  return allGroups;
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
  const contactBody = {
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
  };
  console.log('Zoho contact request body:', JSON.stringify(contactBody, null, 2));
  try {
    const response = await axios.post('https://www.zohoapis.in/books/v3/contacts', contactBody, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: process.env.ZOHO_ORG_ID }
    });
    console.log('Zoho contact response:', JSON.stringify(response.data, null, 2));
    return response.data.contact;
  } catch (error) {
    const errorData = error.response?.data;
    if (errorData?.code === 3062) {
      console.log('Contact already exists in Zoho, searching by phone...');
      const existing = await searchZohoContactByPhone(contactData.phone);
      if (existing) {
        console.log('Found existing Zoho contact:', existing.contact_id);
        return existing;
      }
    }
    console.error('createZohoContact error:', JSON.stringify(errorData, null, 2));
    throw new Error(JSON.stringify(errorData || error.message));
  }
}

async function searchZohoContactByPhone(phone) {
  const token = await getAccessToken();
  const response = await axios.get(`${process.env.ZOHO_API_DOMAIN}/books/v3/contacts`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: {
      organization_id: process.env.ZOHO_ORG_ID,
      search_text: phone,
      contact_type: 'customer'
    }
  });
  const contacts = response.data.contacts;
  if (contacts && contacts.length > 0) {
    return contacts[0];
  }
  return null;
}

async function updateZohoItemImage(itemId, imageUrl) {
  const token = await getAccessToken();
  const response = await axios.put(`${process.env.ZOHO_API_DOMAIN}/inventory/v1/items/${itemId}`, {
    custom_fields: [{ label: 'Image URL', value: imageUrl }]
  }, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: process.env.ZOHO_ORG_ID }
  });
  return response.data.item;
}

async function updateZohoItemFeatured(itemId, featured) {
  const token = await getAccessToken();
  const response = await axios.put(`${process.env.ZOHO_API_DOMAIN}/inventory/v1/items/${itemId}`, {
    custom_fields: [{ label: 'Featured', value: featured }]
  }, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: process.env.ZOHO_ORG_ID }
  });
  return response.data.item;
}

async function updateZohoContact(zohoContactId, contactData) {
  console.log('updateZohoContact called with:', { zohoContactId, contactData });
  const token = await getAccessToken();
  const updateBody = {};

  if (contactData.name || contactData.business_name) {
    updateBody.contact_name = contactData.business_name || contactData.name;
    updateBody.company_name = contactData.business_name || contactData.name;
  }
  if (contactData.name) {
    updateBody.contact_persons = [{
      first_name: contactData.name,
      last_name: '',
      mobile: contactData.phone,
      is_primary_contact: true
    }];
  }
  if (contactData.gstin) {
    updateBody.gst_no = contactData.gstin;
    updateBody.gst_treatment = 'business_gst';
  }
  if (contactData.registered_address) {
    updateBody.place_of_contact = contactData.registered_address.state_code || 'TN';
    updateBody.billing_address = {
      attention: contactData.business_name || contactData.name || '',
      address: contactData.registered_address.address_line1 || '',
      street2: contactData.registered_address.address_line2 || '',
      city: contactData.registered_address.city || '',
      state: contactData.registered_address.state || '',
      zip: contactData.registered_address.pincode || '',
      country: 'India'
    };
  }

  console.log('updateZohoContact body sent to Zoho:', JSON.stringify(updateBody, null, 2));
  const response = await axios.put(
    `https://www.zohoapis.in/books/v3/contacts/${zohoContactId}`,
    updateBody,
    {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: process.env.ZOHO_ORG_ID }
    }
  );
  console.log('updateZohoContact Zoho response:', JSON.stringify(response.data, null, 2));
  return response.data.contact;
}

module.exports = {
  getAccessToken,
  getZohoProducts,
  getZohoProductById,
  getZohoCategories,
  getZohoItemGroups,
  getZohoItemGroupById,
  createZohoContact,
  updateZohoContact,
  updateZohoItemImage,
  updateZohoItemFeatured,
  searchZohoContactByPhone
};
