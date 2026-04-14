// lib/screens/order_detail_screen.dart
import 'package:flutter/material.dart';
import '../models/app_state.dart';
import '../widgets/shared.dart';

class OrderDetailScreen extends StatelessWidget {
  final Order order;
  const OrderDetailScreen({super.key, required this.order});

  double get _subtotal =>
      order.items.fold(0, (s, i) => s + i.total);
  double get _gst => _subtotal * 0.18;
  double get _shipping =>
      order.total - _subtotal - _gst < 0 ? 0 : order.total - _subtotal - _gst;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: kSlate50,
      body: Column(
        children: [
          // ── App bar ──────────────────────────────────────────────────────
          Container(
            color: Colors.white,
            child: SafeArea(
              bottom: false,
              child: SizedBox(
                height: 72,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Row(
                    children: [
                      GestureDetector(
                        onTap: () => Navigator.pop(context),
                        child: Container(
                          width: 40,
                          height: 40,
                          margin: const EdgeInsets.only(right: 12),
                          decoration: BoxDecoration(
                            color: kSlate50,
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(color: kSlate200),
                          ),
                          child: const Icon(Icons.chevron_left,
                              size: 22, color: kSlate800),
                        ),
                      ),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Text(
                              'Invoice Details',
                              style: TextStyle(
                                fontSize: 18,
                                fontWeight: FontWeight.w900,
                                color: kSlate900,
                                letterSpacing: -0.5,
                              ),
                            ),
                            Text(
                              'Order #${order.id}',
                              style: const TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.w700,
                                color: kSlate400,
                                letterSpacing: 1,
                              ),
                            ),
                          ],
                        ),
                      ),
                      Container(
                        width: 40,
                        height: 40,
                        decoration: BoxDecoration(
                          color: kSlate50,
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: kSlate200),
                        ),
                        child: const Icon(Icons.download_outlined,
                            size: 20, color: kSlate600),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          // ── Content ──────────────────────────────────────────────────────
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Column(
                children: [
                  // Status banner
                  Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 16, vertical: 14),
                    decoration: BoxDecoration(
                      color: const Color(0xFFEFF6FF),
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: const Color(0xFFBFDBFE)),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.access_time_outlined,
                            size: 20, color: Color(0xFF2563EB)),
                        const SizedBox(width: 10),
                        Text(
                          'Order ${order.status}',
                          style: const TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w900,
                            color: Color(0xFF2563EB),
                          ),
                        ),
                        const Spacer(),
                        Text(
                          order.date,
                          style: const TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w700,
                            color: Color(0xFF93C5FD),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  // Status timeline
                  AppCard(
                    padding: const EdgeInsets.all(20),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'ORDER TIMELINE',
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w900,
                            color: kSlate400,
                            letterSpacing: 2,
                          ),
                        ),
                        const SizedBox(height: 16),
                        _TimelineStep(
                          label: 'Order Placed',
                          desc: order.date,
                          isDone: true,
                          isLast: false,
                        ),
                        _TimelineStep(
                          label: 'Confirmed',
                          desc: 'Warehouse processing',
                          isDone: order.status != 'Processing',
                          isLast: false,
                        ),
                        _TimelineStep(
                          label: 'Dispatched',
                          desc: 'Loaded on truck',
                          isDone: order.status == 'On the way' ||
                              order.status == 'Delivered',
                          isLast: false,
                        ),
                        _TimelineStep(
                          label: 'Delivered',
                          desc: 'Estimated by 6:30 PM',
                          isDone: order.status == 'Delivered',
                          isLast: true,
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  // Delivery info
                  AppCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'DELIVERY INFO',
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w900,
                            color: kSlate400,
                            letterSpacing: 2,
                          ),
                        ),
                        const SizedBox(height: 16),
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
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  const Text(
                                    'SHIPPING SITE',
                                    style: TextStyle(
                                      fontSize: 9,
                                      fontWeight: FontWeight.w900,
                                      color: kSlate400,
                                      letterSpacing: 1.5,
                                    ),
                                  ),
                                  const SizedBox(height: 2),
                                  Text(
                                    order.address,
                                    style: const TextStyle(
                                      fontSize: 13,
                                      fontWeight: FontWeight.w700,
                                      color: kSlate900,
                                      height: 1.3,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 16),
                        Row(
                          children: [
                            Container(
                              width: 44,
                              height: 44,
                              decoration: BoxDecoration(
                                color: const Color(0xFFFFF7ED),
                                borderRadius: BorderRadius.circular(12),
                                border: Border.all(
                                    color: const Color(0xFFFED7AA)),
                              ),
                              child: const Icon(Icons.access_time_outlined,
                                  size: 22, color: kOrange),
                            ),
                            const SizedBox(width: 12),
                            Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Text(
                                  'ESTIMATED ARRIVAL (ETA)',
                                  style: TextStyle(
                                    fontSize: 9,
                                    fontWeight: FontWeight.w900,
                                    color: kSlate400,
                                    letterSpacing: 1.5,
                                  ),
                                ),
                                const SizedBox(height: 2),
                                const Text(
                                  'Today, 6:30 PM',
                                  style: TextStyle(
                                    fontSize: 14,
                                    fontWeight: FontWeight.w900,
                                    color: kOrange,
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  // Items
                  AppCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'ITEMIZED MATERIALS',
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w900,
                            color: kSlate400,
                            letterSpacing: 2,
                          ),
                        ),
                        const SizedBox(height: 12),
                        ...order.items.map((item) => Padding(
                              padding: const EdgeInsets.only(bottom: 12),
                              child: Row(
                                children: [
                                  ClipRRect(
                                    borderRadius: BorderRadius.circular(10),
                                    child: SizedBox(
                                      width: 52,
                                      height: 52,
                                      child: ProductImage(
                                          url: item.product.imageUrl),
                                    ),
                                  ),
                                  const SizedBox(width: 12),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          item.product.name,
                                          maxLines: 2,
                                          overflow: TextOverflow.ellipsis,
                                          style: const TextStyle(
                                            fontSize: 12,
                                            fontWeight: FontWeight.w700,
                                            color: kSlate900,
                                            height: 1.3,
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
                  // Payment summary
                  AppCard(
                    child: Column(
                      children: [
                        const Align(
                          alignment: Alignment.centerLeft,
                          child: Text(
                            'PAYMENT SUMMARY',
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
                        ),
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          child: Divider(color: kSlate100, height: 1),
                        ),
                        SummaryRow(
                          label: 'NET TOTAL PAID',
                          value: '₹${order.total.toStringAsFixed(0)}',
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
          // ── Track button ──────────────────────────────────────────────────
          Container(
            padding: EdgeInsets.fromLTRB(
                20, 16, 20, MediaQuery.of(context).padding.bottom + 12),
            decoration: BoxDecoration(
              color: Colors.white,
              border: Border(top: BorderSide(color: kSlate100)),
            ),
            child: PrimaryButton(
              label: 'TRACK LIVE SUPPLY',
              icon: Icons.local_shipping_outlined,
              onTap: () {},
            ),
          ),
        ],
      ),
    );
  }
}

// ── Timeline step ─────────────────────────────────────────────────────────────

class _TimelineStep extends StatelessWidget {
  final String label;
  final String desc;
  final bool isDone;
  final bool isLast;

  const _TimelineStep({
    required this.label,
    required this.desc,
    required this.isDone,
    required this.isLast,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Column(
          children: [
            Container(
              width: 20,
              height: 20,
              decoration: BoxDecoration(
                color: isDone ? kPrimary : kSlate100,
                shape: BoxShape.circle,
                border: Border.all(
                  color: isDone ? kPrimary : kSlate200,
                  width: 2,
                ),
              ),
              child: isDone
                  ? const Icon(Icons.check, size: 12, color: Colors.white)
                  : null,
            ),
            if (!isLast)
              Container(
                width: 2,
                height: 28,
                color: isDone ? kPrimary.withOpacity(0.3) : kSlate100,
              ),
          ],
        ),
        const SizedBox(width: 12),
        Padding(
          padding: const EdgeInsets.only(top: 2),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w800,
                  color: isDone ? kSlate900 : kSlate400,
                ),
              ),
              Text(
                desc,
                style: const TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w500,
                  color: kSlate400,
                ),
              ),
              if (!isLast) const SizedBox(height: 8),
            ],
          ),
        ),
      ],
    );
  }
}
