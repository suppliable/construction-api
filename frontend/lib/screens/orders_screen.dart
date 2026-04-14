// lib/screens/orders_screen.dart
import 'package:flutter/material.dart';
import '../models/app_state.dart';
import '../widgets/shared.dart';
import 'order_detail_screen.dart';

class OrdersScreen extends StatelessWidget {
  final AppState appState;
  const OrdersScreen({super.key, required this.appState});

  List<Order> get _mockOrders => [
        Order(
          id: '8841',
          date: '12 Apr, 2026',
          total: 124500,
          status: 'Processing',
          itemsCount: 12,
          address: 'Plot 44, Okhla Phase 3, Delhi',
          items: [
            CartItem(
              cartId: 'm1',
              product: kProducts[0],
              selectedVariant: kProducts[0].variants[1],
              qty: 10,
            ),
            CartItem(
              cartId: 'm1b',
              product: kProducts[1],
              qty: 5,
            ),
          ],
        ),
        Order(
          id: '8792',
          date: '08 Apr, 2026',
          total: 65400,
          status: 'On the way',
          itemsCount: 8,
          address: 'Plot 44, Okhla Phase 3, Delhi',
          items: [
            CartItem(
              cartId: 'm2',
              product: kProducts[10],
              selectedVariant: kProducts[10].variants[2],
              qty: 15,
            ),
          ],
        ),
        Order(
          id: '8741',
          date: '01 Apr, 2026',
          total: 42800,
          status: 'Delivered',
          itemsCount: 5,
          address: 'Sector 62, Noida, UP',
          items: [
            CartItem(
              cartId: 'm3',
              product: kProducts[14],
              selectedVariant: kProducts[14].variants[1],
              qty: 3,
            ),
          ],
        ),
      ];

  List<Order> get _allOrders =>
      [...appState.orders, ..._mockOrders];

  @override
  Widget build(BuildContext context) {
    final orders = _allOrders;
    return Scaffold(
      backgroundColor: kSlate50,
      body: Column(
        children: [
          Container(
            color: Colors.white,
            child: SafeArea(
              bottom: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'SUPPLY HISTORY',
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w900,
                        color: kSlate900,
                        letterSpacing: -0.5,
                      ),
                    ),
                    const Text(
                      'TRACKING & PAST INVOICES',
                      style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w700,
                        color: kSlate400,
                        letterSpacing: 1.5,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          Expanded(
            child: orders.isEmpty
                ? _EmptyOrders()
                : ListView.separated(
                    padding: const EdgeInsets.all(16),
                    itemCount: orders.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 12),
                    itemBuilder: (_, i) => _OrderCard(
                      order: orders[i],
                      onTap: () => Navigator.push(
                        context,
                        MaterialPageRoute(
                          builder: (_) =>
                              OrderDetailScreen(order: orders[i]),
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

// ── Order card ────────────────────────────────────────────────────────────────

class _OrderCard extends StatelessWidget {
  final Order order;
  final VoidCallback onTap;

  const _OrderCard({required this.order, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: kSlate100),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withOpacity(0.04),
              blurRadius: 8,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        child: Column(
          children: [
            // Header row
            Padding(
              padding:
                  const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: Row(
                children: [
                  Row(
                    children: [
                      const Icon(Icons.calendar_today_outlined,
                          size: 13, color: kSlate400),
                      const SizedBox(width: 5),
                      Text(
                        order.date,
                        style: const TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                          color: kSlate400,
                        ),
                      ),
                    ],
                  ),
                  const Spacer(),
                  StatusChip(order.status),
                ],
              ),
            ),
            Divider(color: kSlate50, height: 1),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Invoice #${order.id}',
                          style: const TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w900,
                            color: kSlate900,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          '${order.itemsCount} materials',
                          style: const TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                            color: kSlate400,
                          ),
                        ),
                      ],
                    ),
                  ),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Text(
                        '₹${order.total.toStringAsFixed(0)}',
                        style: const TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w900,
                          color: kSlate900,
                        ),
                      ),
                      Row(
                        children: const [
                          Text(
                            'Details',
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w700,
                              color: kPrimary,
                            ),
                          ),
                          Icon(Icons.chevron_right,
                              size: 16, color: kPrimary),
                        ],
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _EmptyOrders extends StatelessWidget {
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
            child: const Icon(Icons.assignment_outlined,
                size: 40, color: kSlate400),
          ),
          const SizedBox(height: 20),
          const Text(
            'No orders yet',
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w900,
              color: kSlate900,
            ),
          ),
          const SizedBox(height: 8),
          const Text(
            'Your supply orders will appear here.',
            style: TextStyle(
              fontSize: 13,
              color: kSlate400,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }
}
