// lib/models/app_state.dart
import 'package:flutter/foundation.dart';

export '../data/mock_data.dart' show kCategories, kProducts;

// ── Domain models ─────────────────────────────────────────────────────────────

class ProductVariant {
  final String id;
  final String name;
  final double price;
  final int stock;

  const ProductVariant({
    required this.id,
    required this.name,
    required this.price,
    required this.stock,
  });
}

class Product {
  final String id;
  final String name;
  final String brand;
  final String category;
  final String imageUrl;
  final String description;
  final double? price;
  final int? stock;
  final List<ProductVariant> variants;

  const Product({
    required this.id,
    required this.name,
    required this.brand,
    required this.category,
    required this.imageUrl,
    required this.description,
    this.price,
    this.stock,
    this.variants = const [],
  });

  bool get hasVariants => variants.isNotEmpty;

  String get priceRange {
    if (!hasVariants) return '₹${price?.toStringAsFixed(0) ?? "0"}';
    final prices = variants.map((v) => v.price).toList()..sort();
    return '₹${prices.first.toStringAsFixed(0)} – ₹${prices.last.toStringAsFixed(0)}';
  }
}

class CartItem {
  final String cartId;
  final Product product;
  final ProductVariant? selectedVariant;
  int qty;

  CartItem({
    required this.cartId,
    required this.product,
    this.selectedVariant,
    this.qty = 1,
  });

  double get price => selectedVariant?.price ?? product.price ?? 0;
  double get total => price * qty;

  String get displayVariant => selectedVariant?.name ?? 'Standard';
}

class Order {
  final String id;
  final String date;
  final double total;
  final String status;
  final int itemsCount;
  final String address;
  final List<CartItem> items;
  final String paymentMethod;

  const Order({
    required this.id,
    required this.date,
    required this.total,
    required this.status,
    required this.itemsCount,
    required this.address,
    required this.items,
    this.paymentMethod = 'COD',
  });
}

class DeliveryAddress {
  final String id;
  final String label;
  final String address;
  final String type; // 'Work' | 'Home' | 'Site'

  const DeliveryAddress({
    required this.id,
    required this.label,
    required this.address,
    this.type = 'Work',
  });
}

// ── App-wide state (singleton ChangeNotifier) ─────────────────────────────────

class AppState extends ChangeNotifier {
  // Singleton
  static final AppState _instance = AppState._internal();
  factory AppState() => _instance;
  AppState._internal();

  // ── Cart ───────────────────────────────────────────────────────────────────

  final List<CartItem> _cart = [];
  List<CartItem> get cart => List.unmodifiable(_cart);

  // ── Orders ─────────────────────────────────────────────────────────────────

  final List<Order> _orders = [];
  List<Order> get orders => List.unmodifiable(_orders);

  // ── Profile ────────────────────────────────────────────────────────────────

  String deliveryAddress = 'Plot 44, Okhla Phase 3, Delhi';
  String gstNumber = '';
  String businessName = '';
  String phone = '';

  final List<DeliveryAddress> addresses = [
    const DeliveryAddress(
      id: '1',
      label: 'Primary Site',
      address: 'Plot 44, Okhla Phase 3, Delhi',
      type: 'Work',
    ),
  ];

  // ── Cart operations ────────────────────────────────────────────────────────

  void addToCart(Product product, {ProductVariant? variant, int qty = 1}) {
    final idx = _cart.indexWhere(
      (c) => c.product.id == product.id && c.selectedVariant?.id == variant?.id,
    );
    if (idx >= 0) {
      _cart[idx].qty += qty;
    } else {
      _cart.add(CartItem(
        cartId: '${product.id}_${variant?.id ?? "std"}_${DateTime.now().millisecondsSinceEpoch}',
        product: product,
        selectedVariant: variant,
        qty: qty,
      ));
    }
    notifyListeners();
  }

  void updateQty(String cartId, int delta) {
    final idx = _cart.indexWhere((c) => c.cartId == cartId);
    if (idx < 0) return;
    _cart[idx].qty += delta;
    if (_cart[idx].qty <= 0) _cart.removeAt(idx);
    notifyListeners();
  }

  void removeFromCart(String cartId) {
    _cart.removeWhere((c) => c.cartId == cartId);
    notifyListeners();
  }

  CartItem? cartItemFor(Product product, ProductVariant? variant) {
    try {
      return _cart.firstWhere(
        (c) => c.product.id == product.id && c.selectedVariant?.id == variant?.id,
      );
    } catch (_) {
      return null;
    }
  }

  // ── Order operations ───────────────────────────────────────────────────────

  Order placeOrder({String paymentMethod = 'COD'}) {
    final subtotal = _cart.fold<double>(0, (s, i) => s + i.total);
    final gst = subtotal * 0.18;
    final shipping = subtotal > 25000 ? 0.0 : 1500.0;
    final order = Order(
      id: (8800 + _orders.length * 7 + 41).toString(),
      date: _formattedNow(),
      total: subtotal + gst + shipping,
      status: 'Processing',
      itemsCount: _cart.length,
      address: deliveryAddress,
      items: List.from(_cart),
      paymentMethod: paymentMethod,
    );
    _orders.insert(0, order);
    _cart.clear();
    notifyListeners();
    return order;
  }

  // ── Address operations ─────────────────────────────────────────────────────

  void addAddress(DeliveryAddress addr) {
    addresses.add(addr);
    notifyListeners();
  }

  void removeAddress(String id) {
    addresses.removeWhere((a) => a.id == id);
    notifyListeners();
  }

  void setDeliveryAddress(String addr) {
    deliveryAddress = addr;
    notifyListeners();
  }

  // ── GST / profile ──────────────────────────────────────────────────────────

  void saveGstDetails({required String gst, required String biz}) {
    gstNumber = gst.toUpperCase();
    businessName = biz.toUpperCase();
    notifyListeners();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  String _formattedNow() {
    final now = DateTime.now();
    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
    ];
    return '${now.day} ${months[now.month - 1]}, ${now.year}';
  }
}
