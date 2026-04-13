const {
  getZohoProducts,
  getZohoProductById,
  getZohoItemGroups,
  getZohoItemGroupById
} = require('./zohoService');

// Extract GST from Zoho item tax preferences
const extractGST = (item) => {
  if (item.item_tax_preferences && item.item_tax_preferences.length > 0) {
    const intra = item.item_tax_preferences.find(t => t.tax_specification === 'intra');
    if (intra) return intra.tax_percentage;
    return item.item_tax_preferences[0].tax_percentage;
  }
  return item.tax_percentage || 0;
};

// Build a placeholder image URL from item name
const buildImage = (name) =>
  `https://placehold.co/400x300?text=${encodeURIComponent(name)}`;

const getAllProducts = async (category) => {
  // Fetch item groups and plain items in parallel
  const [zohoItems, zohoGroups] = await Promise.all([
    getZohoProducts(),
    getZohoItemGroups()
  ]);

  // Track which item IDs belong to a group (to avoid duplicates)
  const groupedItemIds = new Set();
  zohoGroups.forEach(g => g.items.forEach(i => groupedItemIds.add(i.item_id)));

  // Build grouped products (hasVariants: true)
  const groupedProducts = await Promise.all(
    zohoGroups.map(async (group) => {
      const fullGroup = await getZohoItemGroupById(group.group_id);

      const variants = group.items.map(v => ({
        id: v.item_id,
        name: v.attribute_option_name1 || v.name,
        price: v.rate,
        stock: v.reorder_level || 0
      }));

      const prices = variants.map(v => v.price);
      const priceRange = `₹${Math.min(...prices)} - ₹${Math.max(...prices)}`;

      // Get GST from first variant item
      let gst_percentage = 0;
      if (group.items[0]?.item_id) {
        const firstItem = await getZohoProductById(group.items[0].item_id);
        gst_percentage = extractGST(firstItem);
      }

      return {
        id: group.group_id,
        name: group.group_name,
        brand: fullGroup.brand || group.group_name,
        category: fullGroup.category_name || '',
        unit: group.unit,
        description: group.description || '',
        hasVariants: true,
        priceRange,
        variants,
        gst_percentage,
        hsn: group.items[0]?.hsn_or_sac || '',
        image: buildImage(group.group_name),
        fallbackImage: buildImage(group.group_name)
      };
    })
  );

  // Build plain products (hasVariants: false)
  const plainItems = zohoItems.filter(item => !groupedItemIds.has(item.item_id));
  const plainProducts = await Promise.all(
    plainItems.map(async (item) => {
      const fullItem = await getZohoProductById(item.item_id);
      return {
        id: item.item_id,
        name: item.name,
        brand: fullItem.brand || '',
        category: fullItem.category_name || '',
        unit: item.unit,
        description: item.description || '',
        hasVariants: false,
        price: item.rate,
        gst_percentage: extractGST(fullItem),
        hsn: item.hsn_or_sac || '',
        image: buildImage(item.name),
        fallbackImage: buildImage(item.name)
      };
    })
  );

  const allProducts = [...groupedProducts, ...plainProducts];

  if (category) {
    return allProducts.filter(p =>
      p.category.toLowerCase() === category.toLowerCase()
    );
  }

  return allProducts;
};

const getProductById = async (id) => {
  const item = await getZohoProductById(id);
  if (!item) return null;
  return {
    id: item.item_id,
    name: item.name,
    brand: item.brand || '',
    category: item.category_name || '',
    unit: item.unit,
    description: item.description || '',
    hasVariants: false,
    price: item.rate,
    gst_percentage: extractGST(item),
    hsn: item.hsn_or_sac || '',
    image: buildImage(item.name),
    fallbackImage: buildImage(item.name)
  };
};

module.exports = { getAllProducts, getProductById };
