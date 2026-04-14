// lib/screens/cart_screen.dart
import 'package:flutter/material.dart';
import '../models/app_state.dart';
import '../widgets/shared.dart';
import 'checkout_screen.dart';

class CartScreen extends StatefulWidget {
  final AppState appState;
  final VoidCallback onCartChanged;

  const CartScreen({
    super.key,
    required this.appState,
    required this.onCartChanged,
  });

  @override
  State<CartScreen> createState() => _CartScreenState();
}

class _CartScreenState extends State<CartScreen> {
  List<CartItem> get _cart => widget.appState.cart.toList();
  double get _subtotal => _cart.fold(0, (s, i) => s + i.total);
  double get _gst => _subtotal * 0.18;
  double get _shipping => _subtotal > 25000 ? 0 : 1500;
  double get _total => _subtotal + _gst + _shipping;

  void _update(String cartId, int delta) {
    widget.appState.updateQty(cartId, delta);
    widget.onCartChanged();
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: kSlate50,
      body: Column(
        children: [
          // Header
          Container(
            color: Colors.white,
            child: SafeArea(
              bottom: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
                child: Row(
                  children: [
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'MATERIAL CART',
                          style: TextStyle(
                            fontSize: 20,
                            fontWeight: FontWeight.w900,
                            color: kSlate900,
                            letterSpacing: -0.5,
                          ),
                        ),
                        Text(
                          '${_cart.length} UNIQUE ITEMS',
                          style: const TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w700,
                            color: kSlate400,
                            letterSpacing: 1.5,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
          Expanded(
            child: _cart.isEmpty
                ? _EmptyCart()
                : _CartBody(
                    cart: _cart,
                    subtotal: _subtotal,
                    gst: _gst,
                    shipping: _shipping,
                    total: _total,
                    onUpdate: _update,
                    onCheckout: () {
                      Navigator.push(
                        context,
                        MaterialPageRoute(
                          builder: (_) => CheckoutScreen(
                            appState: widget.appState,
                            onOrderPlaced: () {
                              widget.onCartChanged();
                              setState(() {});
                            },
                          ),
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}

// ── Cart body (list + summary + checkout) ─────────────────────────────────────

class _CartBody extends StatelessWidget {
  final List<CartItem> cart;
  final double subtotal;
  final double gst;
  final double shipping;
  final double total;
  final void Function(String cartId, int delta) onUpdate;
  final VoidCallback onCheckout;

  const _CartBody({
    required this.cart,
    required this.subtotal,
    required this.gst,
    required this.shipping,
    required this.total,
    required this.onUpdate,
    required this.onCheckout,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              // Cart items
              ...cart.map((item) => _CartItemTile(
                    item: item,
                    onUpdate: onUpdate,
                  )),
              const SizedBox(height: 16),
              // Summary card
              AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'ORDER SUMMARY',
                      style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w900,
                        color: kSlate400,
                        letterSpacing: 2,
                      ),
                    ),
                    const SizedBox(height: 16),
                    SummaryRow(
                      label: 'Material cost',
                      value: '₹${subtotal.toStringAsFixed(0)}',
                    ),
                    const SizedBox(height: 8),
                    SummaryRow(
                      label: 'GST (18%)',
                      value: '₹${gst.toStringAsFixed(0)}',
                    ),
                    const SizedBox(height: 8),
                    SummaryRow(
                      label: 'Delivery charge',
                      value: shipping == 0
                          ? 'FREE'
                          : '₹${shipping.toStringAsFixed(0)}',
                      valueColor:
                          shipping == 0 ? const Color(0xFF16A34A) : null,
                    ),
                    if (shipping > 0) ...[
                      const SizedBox(height: 6),
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 10, vertical: 6),
                        decoration: BoxDecoration(
                          color: const Color(0xFFFFFBEB),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Text(
                          'Add ₹${(25000 - subtotal).toStringAsFixed(0)} more for FREE delivery',
                          style: const TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w700,
                            color: Color(0xFFD97706),
                          ),
                        ),
                      ),
                    ],
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      child: Divider(color: kSlate100, height: 1),
                    ),
                    SummaryRow(
                      label: 'TOTAL',
                      value: '₹${total.toStringAsFixed(0)}',
                      isBold: true,
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
            ],
          ),
        ),
        // Checkout button
        Container(
          padding: EdgeInsets.fromLTRB(
              20, 16, 20, MediaQuery.of(context).padding.bottom + 12),
          decoration: BoxDecoration(
            color: Colors.white,
            border: Border(top: BorderSide(color: kSlate100)),
          ),
          child: Column(
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    '₹${total.toStringAsFixed(0)}',
                    style: const TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w900,
                      color: kSlate900,
                    ),
                  ),
                  Text(
                    '${cart.fold(0, (s, i) => s + i.qty)} items',
                    style: const TextStyle(
                      fontSize: 12,
                      color: kSlate400,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              PrimaryButton(
                label: 'PROCEED TO CHECKOUT',
                icon: Icons.arrow_forward,
                onTap: onCheckout,
              ),
            ],
          ),
        ),
      ],
    );
  }
}

// ── Cart item tile ────────────────────────────────────────────────────────────

class _CartItemTile extends StatelessWidget {
  final CartItem item;
  final void Function(String cartId, int delta) onUpdate;

  const _CartItemTile({required this.item, required this.onUpdate});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: kSlate100),
      ),
      child: Row(
        children: [
          // Image
          ClipRRect(
            borderRadius: BorderRadius.circular(12),
            child: SizedBox(
              width: 64,
              height: 64,
              child: ProductImage(url: item.product.imageUrl),
            ),
          ),
          const SizedBox(width: 12),
          // Info
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  item.product.name,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: kSlate900,
                    height: 1.3,
                  ),
                ),
                const SizedBox(height: 4),
                if (item.selectedVariant != null)
                  Text(
                    item.selectedVariant!.name,
                    style: const TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      color: kSlate400,
                    ),
                  ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Text(
                      '₹${item.total.toStringAsFixed(0)}',
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w900,
                        color: kSlate900,
                      ),
                    ),
                    const Spacer(),
                    QtyButton(
                      qty: item.qty,
                      onIncrease: () => onUpdate(item.cartId, 1),
                      onDecrease: () => onUpdate(item.cartId, -1),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ── Empty cart ────────────────────────────────────────────────────────────────

class _EmptyCart extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 88,
            height: 88,
            decoration: BoxDecoration(
              color: kSlate100,
              borderRadius: BorderRadius.circular(28),
            ),
            child: const Icon(Icons.shopping_cart_outlined,
                size: 40, color: kSlate400),
          ),
          const SizedBox(height: 20),
          const Text(
            'Your cart is empty',
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w900,
              color: kSlate900,
            ),
          ),
          const SizedBox(height: 8),
          const Text(
            'Add building materials to your cart\nto place a supply order.',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 13,
              color: kSlate400,
              fontWeight: FontWeight.w500,
              height: 1.5,
            ),
          ),
        ],
      ),
    );
  }
}
