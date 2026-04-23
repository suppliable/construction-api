const { getAllProducts, getProductById, clearCache } = require('../services/productService');
const zohoService = require('../services/zohoService');
const { setImage } = require('../services/firestoreService');

const getProducts = async (req, res) => {
  try {
    const { category } = req.query;
    const products = await getAllProducts(category, req.traceContext);
    res.json({ success: true, count: products.length, data: products });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const getProduct = async (req, res) => {
  try {
    const product = await getProductById(req.params.id, req.traceContext);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    res.json({ success: true, data: product });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const PLACEHOLDER_IMAGE = 'https://placehold.co/400x300?text=No+Image';

const updateProductImage = async (req, res) => {
  const { id } = req.params;
  const raw = req.body.image_url;
  const image_url = (!raw || raw.includes('placehold.co')) ? PLACEHOLDER_IMAGE : raw;
  try {
    await zohoService.updateZohoItemImage(id, image_url, req.traceContext);
    await setImage(id, image_url, req.traceContext);
    clearCache();
    res.json({ success: true, message: 'Image updated successfully' });
  } catch (err) {
    // Error code 2006 means item not found — likely a group_id
    if (err.response?.data?.code === 2006) {
      try {
        const group = await zohoService.getZohoItemGroupById(id, req.traceContext);
        const groupId = group.group_id || id;
        req.log.debug({ id, groupId, group_id: group.group_id }, '[image] saving for variant group');
        await Promise.all(group.items.map(item => zohoService.updateZohoItemImage(item.item_id, image_url, req.traceContext)));
        await setImage(groupId, image_url, req.traceContext);
        clearCache();
        return res.json({ success: true, message: 'Image updated successfully for all variants' });
      } catch (groupErr) {
        return res.status(500).json({ success: false, message: groupErr.message });
      }
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getProducts, getProduct, updateProductImage };
