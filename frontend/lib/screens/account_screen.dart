// lib/screens/account_screen.dart
import 'package:flutter/material.dart';
import '../models/app_state.dart';
import '../widgets/shared.dart';
import 'add_address_screen.dart';
import 'add_gst_screen.dart';
import 'login_screen.dart';
import 'terms_screen.dart';
import 'return_policy_screen.dart';

class AccountScreen extends StatelessWidget {
  final AppState appState;
  const AccountScreen({super.key, required this.appState});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: kSlate50,
      body: SingleChildScrollView(
        child: Column(
          children: [
            // ── Profile header ─────────────────────────────────────────────
            Container(
              color: Colors.white,
              child: SafeArea(
                bottom: false,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 24, 20, 28),
                  child: Column(
                    children: [
                      Container(
                        width: 76,
                        height: 76,
                        decoration: BoxDecoration(
                          color: kPrimary,
                          borderRadius: BorderRadius.circular(24),
                          boxShadow: [
                            BoxShadow(
                              color: kPrimary.withOpacity(0.3),
                              blurRadius: 16,
                              offset: const Offset(0, 6),
                            ),
                          ],
                        ),
                        child: const Center(
                          child: Text(
                            'SS',
                            style: TextStyle(
                              fontSize: 26,
                              fontWeight: FontWeight.w900,
                              color: Colors.white,
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 14),
                      const Text(
                        'Samrat Singh',
                        style: TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.w900,
                          color: kSlate900,
                          letterSpacing: -0.5,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 12, vertical: 4),
                        decoration: BoxDecoration(
                          color: kPrimary.withOpacity(0.08),
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: const Text(
                          'VERIFIED BUILDER ACCOUNT',
                          style: TextStyle(
                            fontSize: 9,
                            fontWeight: FontWeight.w900,
                            color: kPrimary,
                            letterSpacing: 1.5,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(height: 16),
            // ── Menu groups ───────────────────────────────────────────────
            _MenuGroup(
              title: 'PERSONAL',
              items: [
                _MenuItem(
                  icon: Icons.business_outlined,
                  label: 'GST Details',
                  sub: appState.gstNumber.isEmpty
                      ? 'Add your GSTIN'
                      : appState.gstNumber,
                  onTap: () => Navigator.push(
                    context,
                    MaterialPageRoute(
                      builder: (_) => AddGstScreen(appState: appState),
                    ),
                  ),
                ),
                _MenuItem(
                  icon: Icons.bookmark_outline,
                  label: 'Addresses',
                  sub: appState.deliveryAddress.split(',').first,
                  onTap: () => Navigator.push(
                    context,
                    MaterialPageRoute(
                      builder: (_) =>
                          AddAddressScreen(appState: appState),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            _MenuGroup(
              title: 'SUPPORT',
              items: [
                _MenuItem(
                  icon: Icons.chat_bubble_outline,
                  label: 'Chat with us',
                  sub: 'Talk on WhatsApp',
                  highlight: true,
                  onTap: () {},
                ),
                _MenuItem(
                  icon: Icons.description_outlined,
                  label: 'Request Quote',
                  sub: 'Bulk order pricing',
                  onTap: () {},
                ),
              ],
            ),
            const SizedBox(height: 12),
            _MenuGroup(
              title: 'OTHER',
              items: [
                _MenuItem(
                  icon: Icons.verified_outlined,
                  label: 'Terms & Conditions',
                  sub: 'Legal agreements',
                  onTap: () => Navigator.push(context,
                      MaterialPageRoute(builder: (_) => const TermsScreen())),
                ),
                _MenuItem(
                  icon: Icons.assignment_return_outlined,
                  label: 'Return Policy',
                  sub: 'Refunds & replacements',
                  onTap: () => Navigator.push(context,
                      MaterialPageRoute(
                          builder: (_) => const ReturnPolicyScreen())),
                ),
              ],
            ),
            const SizedBox(height: 16),
            // ── Logout ─────────────────────────────────────────────────────
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: GestureDetector(
                onTap: () {
                  Navigator.of(context).pushAndRemoveUntil(
                    MaterialPageRoute(builder: (_) => const LoginScreen()),
                    (_) => false,
                  );
                },
                child: Container(
                  height: 56,
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(18),
                    border: Border.all(color: const Color(0xFFFECACA)),
                  ),
                  child: const Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(Icons.logout, size: 20, color: Color(0xFFEF4444)),
                      SizedBox(width: 8),
                      Text(
                        'LOGOUT',
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w900,
                          color: Color(0xFFEF4444),
                          letterSpacing: 2,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(height: 32),
          ],
        ),
      ),
    );
  }
}

// ── Menu group ────────────────────────────────────────────────────────────────

class _MenuGroup extends StatelessWidget {
  final String title;
  final List<_MenuItem> items;

  const _MenuGroup({required this.title, required this.items});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(left: 4, bottom: 8),
            child: Text(
              title,
              style: const TextStyle(
                fontSize: 10,
                fontWeight: FontWeight.w900,
                color: kSlate400,
                letterSpacing: 2,
              ),
            ),
          ),
          Container(
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(20),
              border: Border.all(color: kSlate100),
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withOpacity(0.03),
                  blurRadius: 8,
                  offset: const Offset(0, 2),
                ),
              ],
            ),
            child: Column(
              children: items.asMap().entries.map((e) {
                final isLast = e.key == items.length - 1;
                return Column(
                  children: [
                    e.value,
                    if (!isLast)
                      Divider(
                        height: 1,
                        indent: 72,
                        color: kSlate50,
                      ),
                  ],
                );
              }).toList(),
            ),
          ),
        ],
      ),
    );
  }
}

// ── Menu item ─────────────────────────────────────────────────────────────────

class _MenuItem extends StatelessWidget {
  final IconData icon;
  final String label;
  final String sub;
  final bool highlight;
  final VoidCallback? onTap;

  const _MenuItem({
    required this.icon,
    required this.label,
    required this.sub,
    this.highlight = false,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        splashColor: kPrimary.withOpacity(0.06),
        highlightColor: kSlate50,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
          child: Row(
            children: [
              Container(
                width: 46,
                height: 46,
                decoration: BoxDecoration(
                  color: highlight
                      ? kPrimary.withOpacity(0.08)
                      : kSlate50,
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(
                    color: highlight
                        ? kPrimary.withOpacity(0.2)
                        : kSlate100,
                  ),
                ),
                child: Icon(
                  icon,
                  size: 21,
                  color: highlight ? kPrimary : kSlate400,
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                    label,
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w800,
                      color: kSlate900,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    sub,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w500,
                      color: kSlate400,
                    ),
                  ),
                ],
              ),
            ),
              const Icon(Icons.chevron_right, size: 18, color: kSlate200),
            ],
          ),
        ),
      ),
    );
  }
}
