// lib/screens/checkout_screen.dart
import 'package:flutter/material.dart';
import '../models/app_state.dart';
import '../widgets/shared.dart';
import 'order_success_screen.dart';
import 'add_address_screen.dart';

class CheckoutScreen extends StatefulWidget {
  final AppState appState;
  final VoidCallback onOrderPlaced;

  const CheckoutScreen({
    super.key,
    required this.appState,
    required this.onOrderPlaced,
  });

  @override
  State<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends State<CheckoutScreen> {
  String _paymentMethod = 'COD';
  bool _placing = false;

  AppState get _appState => widget.appState;
  double get _subtotal =>
      _appState.cart.fold(0, (s, i) => s + i.total);
  double get _gst => _subtotal * 0.18;
  double get _shipping => _subtotal > 25000 ? 0 : 1500;
  double get _total => _subtotal + _gst + _shipping;

  Future<void> _placeOrder() async {
    setState(() => _placing = true);
    await Future.delayed(const Duration(milliseconds: 800));
    final order = _appState.placeOrder(paymentMethod: _paymentMethod);
    widget.onOrderPlaced();
    if (mounted) {
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(
          builder: (_) => OrderSuccessScreen(order: order),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: kSlate50,
      body: Column(
        children: [
          SuppliableAppBar(
            title: 'Checkout',
            subtitle: 'Review your order',
          ),
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Column(
                children: [
                  // ── Delivery address ─────────────────────────────────────
                  AppCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            const Text(
                              'DELIVERY ADDRESS',
                              style: TextStyle(
                                fontSize: 10,
                                fontWeight: FontWeight.w900,
                                color: kSlate400,
                                letterSpacing: 2,
                              ),
                            ),
                            const Spacer(),
                            GestureDetector(
                              onTap: () async {
                                await Navigator.push(
                                  context,
                                  MaterialPageRoute(
                                    builder: (_) => AddAddressScreen(
                                        appState: _appState),
                                  ),
                                );
                                setState(() {});
                              },
                              child: const Text(
                                'CHANGE',
                                style: TextStyle(
                                  fontSize: 10,
                                  fontWeight: FontWeight.w900,
                                  color: kPrimary,
                                  letterSpacing: 1,
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 12),
                        Row(
                          children: [
                            Container(
                              width: 44,
                              height: 44,
                              decoration: BoxDecoration(
                                color: kSlate50,
                                borderRadius: BorderRadius.circular(12),
                                border: Border.all(color: kSlate100),
                              ),
                              child: const Icon(Icons.location_on_outlined,
                                  size: 22, color: kPrimary),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Text(
                                _appState.deliveryAddress,
                                style: const TextStyle(
                                  fontSize: 13,
                                  fontWeight: FontWeight.w700,
                                  color: kSlate900,
                                  height: 1.4,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  // ── Items summary ────────────────────────────────────────
                  AppCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '${_appState.cart.length} ITEMS',
                          style: const TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w900,
                            color: kSlate400,
                            letterSpacing: 2,
                          ),
                        ),
                        const SizedBox(height: 12),
                        ..._appState.cart.map((item) => Padding(
                              padding: const EdgeInsets.only(bottom: 10),
                              child: Row(
                                children: [
                                  ClipRRect(
                                    borderRadius: BorderRadius.circular(8),
                                    child: SizedBox(
                                      width: 44,
                                      height: 44,
                                      child: ProductImage(
                                          url: item.product.imageUrl),
                                    ),
                                  ),
                                  const SizedBox(width: 10),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          item.product.name,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: const TextStyle(
                                            fontSize: 12,
                                            fontWeight: FontWeight.w700,
                                            color: kSlate900,
                                          ),
                                        ),
                                        Text(
                                          '${item.displayVariant} × ${item.qty}',
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
                                    '₹${item.total.toStringAsFixed(0)}',
                                    style: const TextStyle(
                                      fontSize: 13,
                                      fontWeight: FontWeight.w900,
                                      color: kSlate900,
                                    ),
                                  ),
                                ],
                              ),
                            )),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  // ── Payment method ────────────────────────────────────────
                  AppCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'PAYMENT METHOD',
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w900,
                            color: kSlate400,
                            letterSpacing: 2,
                          ),
                        ),
                        const SizedBox(height: 12),
                        _PaymentOption(
                          id: 'COD',
                          title: 'Cash on Delivery',
                          subtitle: 'Pay when materials arrive',
                          icon: Icons.money_outlined,
                          selected: _paymentMethod == 'COD',
                          onTap: () =>
                              setState(() => _paymentMethod = 'COD'),
                        ),
                        const SizedBox(height: 10),
                        _PaymentOption(
                          id: 'ONLINE',
                          title: 'Online Payment',
                          subtitle: 'UPI / Net banking / Card',
                          icon: Icons.credit_card_outlined,
                          selected: _paymentMethod == 'ONLINE',
                          onTap: () =>
                              setState(() => _paymentMethod = 'ONLINE'),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  // ── Price summary ────────────────────────────────────────
                  AppCard(
                    child: Column(
                      children: [
                        const Align(
                          alignment: Alignment.centerLeft,
                          child: Text(
                            'PRICE BREAKDOWN',
                            style: TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.w900,
                              color: kSlate400,
                              letterSpacing: 2,
                            ),
                          ),
                        ),
                        const SizedBox(height: 12),
                        SummaryRow(
                          label: 'Material cost',
                          value: '₹${_subtotal.toStringAsFixed(0)}',
                        ),
                        const SizedBox(height: 8),
                        SummaryRow(
                          label: 'GST (18%)',
                          value: '₹${_gst.toStringAsFixed(0)}',
                        ),
                        const SizedBox(height: 8),
                        SummaryRow(
                          label: 'Delivery',
                          value: _shipping == 0
                              ? 'FREE'
                              : '₹${_shipping.toStringAsFixed(0)}',
                          valueColor: _shipping == 0
                              ? const Color(0xFF16A34A)
                              : null,
                        ),
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          child: Divider(color: kSlate100, height: 1),
                        ),
                        SummaryRow(
                          label: 'TOTAL PAYABLE',
                          value: '₹${_total.toStringAsFixed(0)}',
                          isBold: true,
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 24),
                ],
              ),
            ),
          ),
          // ── Place order ──────────────────────────────────────────────────
          Container(
            padding: EdgeInsets.fromLTRB(
                20, 16, 20, MediaQuery.of(context).padding.bottom + 12),
            decoration: BoxDecoration(
              color: Colors.white,
              border: Border(top: BorderSide(color: kSlate100)),
            ),
            child: PrimaryButton(
              label: 'PLACE ORDER',
              icon: Icons.check_circle_outline,
              loading: _placing,
              onTap: _placeOrder,
            ),
          ),
        ],
      ),
    );
  }
}

// ── Payment option tile ───────────────────────────────────────────────────────

class _PaymentOption extends StatelessWidget {
  final String id;
  final String title;
  final String subtitle;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;

  const _PaymentOption({
    required this.id,
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: selected ? kPrimary.withOpacity(0.05) : kSlate50,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: selected ? kPrimary : kSlate100,
            width: selected ? 2 : 1,
          ),
        ),
        child: Row(
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: selected
                    ? kPrimary.withOpacity(0.1)
                    : Colors.white,
                borderRadius: BorderRadius.circular(10),
              ),
              child:
                  Icon(icon, size: 20, color: selected ? kPrimary : kSlate400),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w800,
                      color: selected ? kPrimary : kSlate900,
                    ),
                  ),
                  Text(
                    subtitle,
                    style: const TextStyle(
                      fontSize: 11,
                      color: kSlate400,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ],
              ),
            ),
            if (selected)
              const Icon(Icons.check_circle, color: kPrimary, size: 20),
          ],
        ),
      ),
    );
  }
}
