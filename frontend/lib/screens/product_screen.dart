// lib/screens/product_screen.dart
import 'package:flutter/material.dart';
import '../models/app_state.dart';
import '../widgets/shared.dart';

class ProductScreen extends StatefulWidget {
  final Product product;
  final AppState appState;
  final VoidCallback onCartChanged;

  const ProductScreen({
    super.key,
    required this.product,
    required this.appState,
    required this.onCartChanged,
  });

  @override
  State<ProductScreen> createState() => _ProductScreenState();
}

class _ProductScreenState extends State<ProductScreen> {
  ProductVariant? _selectedVariant;
  int _qty = 1;
  bool _addedSuccess = false;

  @override
  void initState() {
    super.initState();
    if (widget.product.hasVariants) {
      _selectedVariant = widget.product.variants.first;
    }
  }

  double get _unitPrice =>
      _selectedVariant?.price ?? widget.product.price ?? 0;

  void _handleAddToCart() {
    widget.appState.addToCart(
      widget.product,
      variant: _selectedVariant,
      qty: _qty,
    );
    widget.onCartChanged();
    setState(() => _addedSuccess = true);
    Future.delayed(const Duration(seconds: 2), () {
      if (mounted) setState(() => _addedSuccess = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    final product = widget.product;

    return Scaffold(
      backgroundColor: Colors.white,
      body: Column(
        children: [
          // ── App bar ───────────────────────────────────────────────────────
          Container(
            color: Colors.white,
            child: SafeArea(
              bottom: false,
              child: SizedBox(
                height: 60,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Row(
                    children: [
                      GestureDetector(
                        onTap: () => Navigator.pop(context),
                        child: Container(
                          width: 40,
                          height: 40,
                          decoration: BoxDecoration(
                            color: kSlate50,
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(color: kSlate200),
                          ),
                          child: const Icon(Icons.chevron_left,
                              size: 22, color: kSlate800),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Text(
                          product.name,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w900,
                            color: kSlate400,
                            letterSpacing: 0.5,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          const Divider(height: 1, color: kSlate100),
          // ── Scrollable content ────────────────────────────────────────────
          Expanded(
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Product image
                  AspectRatio(
                    aspectRatio: 1,
                    child: ProductImage(url: product.imageUrl),
                  ),
                  Padding(
                    padding: const EdgeInsets.all(20),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        // Brand + stock row
                        Row(
                          children: [
                            BrandTag(product.brand),
                            const Spacer(),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 10, vertical: 5),
                              decoration: BoxDecoration(
                                color: const Color(0xFFF0FDF4),
                                borderRadius: BorderRadius.circular(20),
                                border: Border.all(
                                    color: const Color(0xFF86EFAC)),
                              ),
                              child: const Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Icon(Icons.circle,
                                      size: 7,
                                      color: Color(0xFF16A34A)),
                                  SizedBox(width: 4),
                                  Text(
                                    'Available',
                                    style: TextStyle(
                                      fontSize: 10,
                                      fontWeight: FontWeight.w700,
                                      color: Color(0xFF16A34A),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 12),
                        // Product name
                        Text(
                          product.name,
                          style: const TextStyle(
                            fontSize: 22,
                            fontWeight: FontWeight.w900,
                            color: kSlate900,
                            height: 1.2,
                            letterSpacing: -0.5,
                          ),
                        ),
                        const SizedBox(height: 14),
                        // Price
                        Text(
                          '₹${(_unitPrice * _qty).toStringAsFixed(0)}',
                          style: const TextStyle(
                            fontSize: 26,
                            fontWeight: FontWeight.w900,
                            color: kPrimary,
                          ),
                        ),
                        if (_qty > 1)
                          Text(
                            '₹${_unitPrice.toStringAsFixed(0)} × $_qty',
                            style: const TextStyle(
                              fontSize: 12,
                              color: kSlate400,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        const SizedBox(height: 20),
                        // Description
                        Text(
                          product.description,
                          style: const TextStyle(
                            fontSize: 14,
                            color: kSlate600,
                            height: 1.6,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                        // ── Variants ──────────────────────────────────────
                        if (product.hasVariants) ...[
                          const SizedBox(height: 28),
                          const Text(
                            'CHOOSE OPTION',
                            style: TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.w900,
                              color: kSlate400,
                              letterSpacing: 2,
                            ),
                          ),
                          const SizedBox(height: 12),
                          ...product.variants.map((v) {
                            final isSelected =
                                _selectedVariant?.id == v.id;
                            return GestureDetector(
                              onTap: () =>
                                  setState(() => _selectedVariant = v),
                              child: AnimatedContainer(
                                duration: const Duration(milliseconds: 150),
                                margin: const EdgeInsets.only(bottom: 10),
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 16, vertical: 14),
                                decoration: BoxDecoration(
                                  color: isSelected
                                      ? kPrimary.withOpacity(0.05)
                                      : Colors.white,
                                  borderRadius: BorderRadius.circular(14),
                                  border: Border.all(
                                    color: isSelected
                                        ? kPrimary
                                        : kSlate100,
                                    width: isSelected ? 2 : 1,
                                  ),
                                ),
                                child: Row(
                                  children: [
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            v.name,
                                            style: TextStyle(
                                              fontSize: 14,
                                              fontWeight: FontWeight.w800,
                                              color: isSelected
                                                  ? kPrimary
                                                  : kSlate900,
                                            ),
                                          ),
                                          Text(
                                            'In stock: ${v.stock}',
                                            style: const TextStyle(
                                              fontSize: 10,
                                              color: kSlate400,
                                              fontWeight: FontWeight.w600,
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                    Text(
                                      '₹${v.price.toStringAsFixed(0)}',
                                      style: const TextStyle(
                                        fontSize: 15,
                                        fontWeight: FontWeight.w900,
                                        color: kSlate900,
                                      ),
                                    ),
                                    if (isSelected) ...[
                                      const SizedBox(width: 8),
                                      const Icon(Icons.check_circle,
                                          size: 18, color: kPrimary),
                                    ],
                                  ],
                                ),
                              ),
                            );
                          }),
                        ],
                        // ── Quantity ──────────────────────────────────────
                        const SizedBox(height: 28),
                        const Text(
                          'QUANTITY',
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w900,
                            color: kSlate400,
                            letterSpacing: 2,
                          ),
                        ),
                        const SizedBox(height: 12),
                        Row(
                          children: [
                            Container(
                              decoration: BoxDecoration(
                                color: kSlate50,
                                borderRadius: BorderRadius.circular(16),
                                border: Border.all(color: kSlate200),
                              ),
                              child: Row(
                                children: [
                                  _QtyBtn(
                                    icon: Icons.remove,
                                    onTap: () {
                                      if (_qty > 1)
                                        setState(() => _qty--);
                                    },
                                  ),
                                  SizedBox(
                                    width: 52,
                                    child: Text(
                                      '$_qty',
                                      textAlign: TextAlign.center,
                                      style: const TextStyle(
                                        fontSize: 18,
                                        fontWeight: FontWeight.w900,
                                        color: kSlate900,
                                      ),
                                    ),
                                  ),
                                  _QtyBtn(
                                    icon: Icons.add,
                                    onTap: () => setState(() => _qty++),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(width: 16),
                            Text(
                              product.hasVariants
                                  ? '${_selectedVariant?.name ?? ""} × $_qty'
                                  : '× $_qty unit${_qty > 1 ? 's' : ''}',
                              style: const TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w600,
                                color: kSlate400,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 100),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          // ── Sticky bottom ─────────────────────────────────────────────────
          Container(
            padding: EdgeInsets.fromLTRB(
                20, 16, 20, MediaQuery.of(context).padding.bottom + 12),
            decoration: BoxDecoration(
              color: Colors.white,
              border: Border(top: BorderSide(color: kSlate100)),
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withOpacity(0.06),
                  blurRadius: 12,
                  offset: const Offset(0, -4),
                ),
              ],
            ),
            child: GestureDetector(
              onTap: (product.hasVariants && _selectedVariant == null)
                  ? null
                  : _handleAddToCart,
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 300),
                height: 56,
                decoration: BoxDecoration(
                  color: _addedSuccess
                      ? const Color(0xFF16A34A)
                      : kSlate900,
                  borderRadius: BorderRadius.circular(18),
                ),
                child: Center(
                  child: _addedSuccess
                      ? const Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(Icons.check_circle,
                                size: 20, color: Colors.white),
                            SizedBox(width: 8),
                            Text(
                              'ADDED TO CART',
                              style: TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.w900,
                                color: Colors.white,
                                letterSpacing: 1,
                              ),
                            ),
                          ],
                        )
                      : Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.add_shopping_cart,
                                size: 20, color: Colors.white),
                            const SizedBox(width: 8),
                            Text(
                              product.hasVariants && _selectedVariant == null
                                  ? 'SELECT AN OPTION'
                                  : 'ADD TO CART',
                              style: const TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.w900,
                                color: Colors.white,
                                letterSpacing: 1.5,
                              ),
                            ),
                          ],
                        ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _QtyBtn extends StatelessWidget {
  final IconData icon;
  final VoidCallback onTap;
  const _QtyBtn({required this.icon, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: SizedBox(
        width: 48,
        height: 48,
        child: Icon(icon, size: 20, color: kSlate400),
      ),
    );
  }
}
