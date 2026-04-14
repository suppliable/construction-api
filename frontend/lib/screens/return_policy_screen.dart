// lib/screens/return_policy_screen.dart
import 'package:flutter/material.dart';
import '../widgets/shared.dart';

class ReturnPolicyScreen extends StatelessWidget {
  const ReturnPolicyScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: kSlate50,
      appBar: SuppliableAppBar(
        title: 'Return Policy',
        subtitle: 'REFUNDS & REPLACEMENTS',
      ),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: const [
          _PolicyHighlight(
            icon: Icons.check_circle_outline,
            text: '48-hour return window from delivery',
          ),
          _PolicyHighlight(
            icon: Icons.swap_horiz_outlined,
            text: 'Replacement or full refund — your choice',
          ),
          _PolicyHighlight(
            icon: Icons.receipt_long_outlined,
            text: 'GST-compliant credit notes issued',
          ),
          SizedBox(height: 8),
          _LegalSection(
            title: 'Eligible Returns',
            body:
                'Returns are accepted within 48 hours of delivery for the following reasons:\n\n• Damaged or broken materials upon arrival\n• Wrong product delivered (brand, grade, or specification mismatch)\n• Quantity shortage versus invoice\n• Manufacturing defects confirmed within the return window\n\nAll return requests must be initiated via the App or WhatsApp support with photographic evidence.',
          ),
          _LegalSection(
            title: 'Non-Returnable Items',
            body:
                'The following cannot be returned:\n\n• Products that have been used, installed, or mixed (e.g., cement, paint opened)\n• Items damaged due to improper storage at site\n• Custom-cut or made-to-order materials\n• Products returned beyond the 48-hour window\n• Items not purchased through the Suppliable platform',
          ),
          _LegalSection(
            title: 'Return Process',
            body:
                '1. Raise a return request in the App under Order Details → "Report an Issue", or contact us on WhatsApp.\n\n2. Our quality team will review your submission (photos required) within 4 business hours.\n\n3. Upon approval, a pickup is scheduled within 24 hours at no charge to you.\n\n4. Once the returned goods are inspected at our warehouse, your replacement or refund is processed.',
          ),
          _LegalSection(
            title: 'Refund Timeline',
            body:
                'Approved refunds are processed as follows:\n\n• Online payments: 5–7 business days to original payment method\n• COD orders: NEFT/UPI transfer within 3–5 business days (bank details required)\n• Store credit (optional): Applied to your account within 24 hours\n\nGST credit notes are issued within 48 hours of return approval for tax compliance.',
          ),
          _LegalSection(
            title: 'Replacement Policy',
            body:
                'If you prefer a replacement over a refund, we will dispatch the correct/undamaged product within 24–48 hours of return pickup confirmation, subject to availability. Priority dispatch is offered for site-critical materials.',
          ),
          _LegalSection(
            title: 'Bulk Order Returns',
            body:
                'For orders above ₹1,00,000, return and replacement terms may be governed by a separate supply agreement. Please contact your account manager or write to us at returns@suppliable.in for bulk order concerns.',
          ),
          _LegalSection(
            title: 'Contact for Returns',
            body:
                'WhatsApp: +91 98765 43210 (9 AM – 7 PM, Mon–Sat)\nEmail: returns@suppliable.in\n\nWe aim to resolve all return requests within 24 business hours.',
          ),
          SizedBox(height: 32),
        ],
      ),
    );
  }
}

class _PolicyHighlight extends StatelessWidget {
  final IconData icon;
  final String text;

  const _PolicyHighlight({required this.icon, required this.text});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: kSlate100),
      ),
      child: Row(
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: kPrimary.withOpacity(0.08),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon, size: 18, color: kPrimary),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w700,
                color: kSlate800,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _LegalSection extends StatelessWidget {
  final String title;
  final String body;

  const _LegalSection({required this.title, required this.body});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w900,
              color: kSlate900,
              letterSpacing: -0.2,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            body,
            style: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w500,
              color: kSlate600,
              height: 1.65,
            ),
          ),
        ],
      ),
    );
  }
}
