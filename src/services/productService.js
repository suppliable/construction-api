const {
  getZohoProducts,
  getZohoItemGroups,
  getZohoCategories
} = require('./zohoService');
const { getImageMap } = require('./firestoreService');

// Extract GST from Zoho item tax preferences
const extractGST = (item) => {
  if (item.item_tax_preferences && item.item_tax_preferences.length > 0) {
    const intra = item.item_tax_preferences.find(t => t.tax_specification === 'intra');
    if (intra) return intra.tax_percentage;
    return item.item_tax_preferences[0].tax_percentage;
  }
  return item.tax_percentage || 0;
};

// Build image URL from custom field or fallback to placeholder
const buildImage = (name, imageUrl) =>
  imageUrl || `https://placehold.co/400x300?text=${encodeURIComponent(name)}`;

// In-memory cache
const cache = {
  products: null,
  groups: null,
  categoryMap: null,
  imageMap: null,
  lastFetched: null,
  TTL: 10 * 60 * 1000 // 10 minutes
};

function isCacheValid() {
  return cache.lastFetched && (Date.now() - cache.lastFetched) < cache.TTL;
}

async function fetchZohoData() {
  if (isCacheValid()) {
    return { items: cache.products, groups: cache.groups, categoryMap: cache.categoryMap };
  }
  const [items, groups, zohoCategories] = await Promise.all([
    getZohoProducts(),
    getZohoItemGroups(),
    getZohoCategories()
  ]);

  // Build category id → name map
  const categoryMap = {};
  zohoCategories.forEach(c => { categoryMap[c.category_id] = c.name; });

  // Build imageMap from Zoho items (custom_field_hash if available)
  const imageMap = {};
  items.forEach(item => {
    if (item.custom_field_hash?.cf_image_url) {
      imageMap[item.item_id] = item.custom_field_hash.cf_image_url;
    }
  });

  // Merge with Firestore imageMap (Firestore values take precedence)
  const firestoreImages = await getImageMap();
  const mergedImageMap = { ...imageMap, ...firestoreImages };

  cache.products = items;
  cache.groups = groups;
  cache.categoryMap = categoryMap;
  cache.imageMap = mergedImageMap;
  cache.lastFetched = Date.now();
  return { items, groups, categoryMap };
}

function clearCache() {
  cache.products = null;
  cache.groups = null;
  cache.categoryMap = null;
  cache.imageMap = null;
  cache.lastFetched = null;
}

const getAllProducts = async (category) => {
  const { items, groups, categoryMap } = await fetchZohoData();

  // Build item lookup map for GST and custom fields
  const itemMap = {};
  items.forEach(item => { itemMap[item.item_id] = item; });


  // Track grouped item IDs
  const groupedItemIds = new Set();
  groups.forEach(g => g.items.forEach(i => groupedItemIds.add(i.item_id)));

  // Build grouped products — NO extra API calls
  const groupedProducts = groups.map(group => {
    const variants = group.items.map(v => ({
      id: v.item_id,
      name: v.attribute_option_name1 || v.name,
      price: v.rate,
      stock: v.stock_on_hand || 0,
      available_stock: v.available_stock || v.actual_available_stock || 0
    }));

    const prices = variants.map(v => v.price);
    const priceRange = prices.length > 1
      ? `₹${Math.min(...prices)} - ₹${Math.max(...prices)}`
      : `₹${prices[0]}`;

    const firstVariantItem = itemMap[group.items[0]?.item_id];
    const category = categoryMap[group.category_id] || categoryMap[firstVariantItem?.category_id] || '';

    const groupImageUrl = cache.imageMap[group.group_id] || cache.imageMap[group.item_id] || cache.imageMap[group.items[0]?.item_id] || buildImage(group.group_name);
    return {
      id: group.group_id,
      name: group.group_name,
      brand: group.brand || group.group_name,
      category,
      unit: group.unit,
      description: group.description || '',
      hasVariants: true,
      priceRange,
      variants,
      gst_percentage: firstVariantItem ? extractGST(firstVariantItem) : 0,
      hsn: firstVariantItem?.hsn_or_sac || '',
      image: groupImageUrl,
      imageUrl: groupImageUrl,
      fallbackImage: buildImage(group.group_name),
      featured: !!(cache.imageMap[`featured_${group.group_id}`])
    };
  });

  // Build plain products — NO extra API calls
  const plainProducts = items
    .filter(item => !groupedItemIds.has(item.item_id))
    .map(item => {
      const itemImageUrl = cache.imageMap[item.item_id] || cache.imageMap[item.id] || buildImage(item.name);
      const zohoFeatured = item.custom_field_hash?.cf_featured === true || item.custom_field_hash?.cf_featured === 'true';
      return {
        id: item.item_id,
        name: item.name,
        brand: item.manufacturer || item.group_name || '',
        category: categoryMap[item.category_id] || '',
        unit: item.unit,
        description: item.description || '',
        hasVariants: false,
        price: item.rate,
        stock: item.stock_on_hand || 0,
        available_stock: item.available_stock || 0,
        gst_percentage: extractGST(item),
        hsn: item.hsn_or_sac || '',
        image: itemImageUrl,
        imageUrl: itemImageUrl,
        fallbackImage: buildImage(item.name),
        featured: !!(cache.imageMap[`featured_${item.item_id}`] ?? zohoFeatured)
      };
    });

  const allProducts = [...groupedProducts, ...plainProducts];

  if (category) {
    return allProducts.filter(p =>
      p.category.toLowerCase() === category.toLowerCase()
    );
  }

  return allProducts;
};

const getProductById = async (id) => {
  const { items, groups, categoryMap } = await fetchZohoData();

  // Check if it's a group id first
  const group = groups.find(g => g.group_id === id);
  if (group) {
    const itemMap = {};
    items.forEach(item => { itemMap[item.item_id] = item; });
    const firstVariantItem = itemMap[group.items[0]?.item_id];
    const variants = group.items.map(v => ({
      id: v.item_id,
      name: v.attribute_option_name1 || v.name,
      price: v.rate,
      stock: v.stock_on_hand || 0,
      available_stock: v.available_stock || v.actual_available_stock || 0
    }));
    const prices = variants.map(v => v.price);
    return {
      id: group.group_id,
      name: group.group_name,
      brand: group.brand || group.group_name,
      category: categoryMap[group.category_id] || '',
      unit: group.unit,
      description: group.description || '',
      hasVariants: true,
      priceRange: `₹${Math.min(...prices)} - ₹${Math.max(...prices)}`,
      variants,
      gst_percentage: firstVariantItem ? extractGST(firstVariantItem) : 0,
      hsn: firstVariantItem?.hsn_or_sac || '',
      image: cache.imageMap[group.group_id] || cache.imageMap[group.item_id] || cache.imageMap[group.items[0]?.item_id] || buildImage(group.group_name),
      imageUrl: cache.imageMap[group.group_id] || cache.imageMap[group.item_id] || cache.imageMap[group.items[0]?.item_id] || buildImage(group.group_name),
      fallbackImage: buildImage(group.group_name)
    };
  }

  // Check if it's a variant item id inside a group
  for (const group of groups) {
    const variant = group.items.find(v => v.item_id === id);
    if (variant) {
      const fullItem = items.find(i => i.item_id === id);
      return {
        id: variant.item_id,
        name: `${group.group_name} ${variant.attribute_option_name1 || ''}`.trim(),
        brand: group.brand || group.group_name,
        category: categoryMap[group.category_id] || categoryMap[fullItem?.category_id] || '',
        unit: group.unit,
        description: group.description || '',
        hasVariants: false,
        price: variant.rate,
        stock: variant.stock_on_hand || 0,
        available_stock: variant.available_stock || variant.actual_available_stock || 0,
        gst_percentage: fullItem ? extractGST(fullItem) : (variant.tax_percentage || extractGST(group)),
        hsn: fullItem?.hsn_or_sac || group.hsn_or_sac || '',
        image: cache.imageMap[id] || buildImage(group.group_name),
        imageUrl: cache.imageMap[id] || buildImage(group.group_name),
        fallbackImage: buildImage(group.group_name)
      };
    }
  }

  // Check plain items
  const item = items.find(i => i.item_id === id);
  if (!item) return null;
  return {
    id: item.item_id,
    name: item.name,
    brand: item.manufacturer || '',
    category: categoryMap[item.category_id] || '',
    unit: item.unit,
    description: item.description || '',
    hasVariants: false,
    price: item.rate,
    stock: item.stock_on_hand || 0,
    available_stock: item.available_stock || 0,
    gst_percentage: extractGST(item),
    hsn: item.hsn_or_sac || '',
    image: cache.imageMap[item.item_id] || buildImage(item.name),
    imageUrl: cache.imageMap[item.item_id] || buildImage(item.name),
    fallbackImage: buildImage(item.name)
  };
};

module.exports = { getAllProducts, getProductById, clearCache };
