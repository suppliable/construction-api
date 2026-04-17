const { getCart, saveCart, getCustomer, getAddressById, saveOrder, getOrdersByUser, getOrderById } = require('../services/firestoreService');
const { getProductById } = require('../services/productService');
const { createZohoSalesOrder } = require('../services/zohoOrderService');

const createOrder = async (req, res) => {
  try {
    const { userId, addressId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'userId is required' });
    if (!addressId) return res.status(400).json({ success: false, message: 'addressId is required' });

    // 1. Fetch cart
    const cart = await getCart(userId);
    if (!cart.items || cart.items.length === 0) {
      return res.status(400).json({ success: false, message: 'Cart is empty' });
    }

    // 2. Fetch address
    const address = await getAddressById(addressId);
    if (!address || address.userId !== userId) {
      return res.status(404).json({ success: false, message: 'Address not found' });
    }

    // 3. Re-validate stock for all items and build enriched line items
    const stockIssues = [];
    const lineItems = [];

    await Promise.all(cart.items.map(async (cartItem) => {
      const product = await getProductById(cartItem.productId);
      if (!product) {
        stockIssues.push({ productId: cartItem.productId, message: 'Product not found' });
        return;
      }
      if (product.available_stock !== undefined && product.available_stock !== null) {
        if (cartItem.quantity > product.available_stock) {
          stockIssues.push({
            productId: cartItem.productId,
            name: product.name,
            requested: cartItem.quantity,
            available: product.available_stock,
            message: product.available_stock <= 0
              ? `Sorry, ${product.name} is out of stock`
              : `Only ${product.available_stock} units available for ${product.name}`
          });
          return;
        }
      }

      const totalWithoutGST = parseFloat((product.price * cartItem.quantity).toFixed(2));
      const gstAmount = parseFloat((totalWithoutGST * product.gst_percentage / 100).toFixed(2));
      const grandTotal = parseFloat((totalWithoutGST + gstAmount).toFixed(2));

      lineItems.push({
        productId: cartItem.productId,
        name: product.name,
        quantity: cartItem.quantity,
        unit: product.unit,
        unitPrice: product.price,
        totalWithoutGST,
        gstRate: product.gst_percentage,
        gstAmount,
        grandTotal
      });
    }));

    if (stockIssues.length > 0) {
      return res.status(400).json({ success: false, message: 'Stock validation failed', issues: stockIssues });
    }

    // 4. Fetch Zoho contact ID and phone from customer record
    const customer = await getCustomer(userId);
    if (!customer || !customer.zoho_contact_id) {
      return res.status(400).json({ success: false, message: 'Customer Zoho account not found' });
    }
    const phone = customer.phone || null;
    const deliveryCharge = cart.deliveryCharge || cart.delivery_charge || 0;

    // 5. Create Sales Order in Zoho Inventory
    const zohoSO = await createZohoSalesOrder(customer.zoho_contact_id, lineItems, address, deliveryCharge, phone);

    // 6. Compute totals
    const subtotal = parseFloat(lineItems.reduce((sum, i) => sum + i.totalWithoutGST, 0).toFixed(2));
    const gst_total = parseFloat(lineItems.reduce((sum, i) => sum + i.gstAmount, 0).toFixed(2));
    const grand_total = parseFloat(lineItems.reduce((sum, i) => sum + i.grandTotal, 0).toFixed(2));

    // 7. Save order to Firestore
    const orderId = 'ORD' + Date.now();
    const order = {
      orderId,
      zoho_so_id: zohoSO.salesorder_id,
      zoho_so_number: zohoSO.salesorder_number,
      userId,
      addressId,
      items: lineItems,
      subtotal,
      gst_total,
      delivery_charge: deliveryCharge,
      grand_total: parseFloat((grand_total + deliveryCharge).toFixed(2)),
      status: 'confirmed',
      createdAt: new Date().toISOString()
    };
    await saveOrder(order);

    // 8. Clear cart
    await saveCart(userId, { items: [] });

    res.json({ success: true, order });
  } catch (err) {
    console.error('createOrder error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
};

const getUserOrders = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ success: false, message: 'userId is required' });
    const orders = await getOrdersByUser(userId);
    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const getOrderDetail = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { createOrder, getUserOrders, getOrderDetail };
