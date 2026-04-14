// lib/screens/terms_screen.dart
import 'package:flutter/material.dart';
import '../widgets/shared.dart';

class TermsScreen extends StatelessWidget {
  const TermsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: kSlate50,
      appBar: SuppliableAppBar(
        title: 'Terms & Conditions',
        subtitle: 'LAST UPDATED: APRIL 2026',
      ),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: const [
          _LegalSection(
            title: '1. Acceptance of Terms',
            body:
                'By accessing or using the Suppliable platform ("App"), you agree to be bound by these Terms & Conditions. If you do not agree, please discontinue use of the App immediately. These terms apply to all users, including registered businesses, contractors, builders, and site managers.',
          ),
          _LegalSection(
            title: '2. Eligibility & Registration',
            body:
                'Suppliable is a B2B platform intended for verified businesses and trade professionals in the construction industry. You must be at least 18 years of age and represent a legally registered business entity to place orders. By registering, you confirm that all information provided is accurate and complete.',
          ),
          _LegalSection(
            title: '3. Products & Pricing',
            body:
                'All product listings, specifications, and prices are subject to change without prior notice. Prices are displayed inclusive of applicable taxes unless stated otherwise. Suppliable reserves the right to modify, discontinue, or limit the availability of any product at any time. Bulk pricing and credit terms are available upon request and subject to separate agreements.',
          ),
          _LegalSection(
            title: '4. Orders & Payment',
            body:
                'Orders placed through the App constitute a binding purchase agreement upon confirmation. Suppliable accepts payment via Cash on Delivery (COD) and online payment methods. In case of payment failure or order cancellation, any amounts charged will be refunded within 5–7 business days to the original payment method.',
          ),
          _LegalSection(
            title: '5. Delivery & Risk',
            body:
                'Delivery timelines are estimates and may vary based on location, product availability, and logistics conditions. Risk of loss and title for items purchased pass to you upon delivery to the specified address. Suppliable is not liable for delays caused by force majeure, government restrictions, or third-party logistics failures.',
          ),
          _LegalSection(
            title: '6. GST & Invoicing',
            body:
                'Tax invoices are generated automatically for all orders. It is your responsibility to provide a valid GSTIN for GST input tax credit claims. Suppliable is not liable for incorrect GSTIN entries or failed ITC claims arising from user error. Invoice disputes must be raised within 48 hours of delivery.',
          ),
          _LegalSection(
            title: '7. Prohibited Use',
            body:
                'You agree not to misuse the platform for fraudulent orders, price manipulation, unauthorised data scraping, or any activity that violates applicable Indian law. Suppliable reserves the right to suspend or terminate accounts that violate these terms without prior notice.',
          ),
          _LegalSection(
            title: '8. Intellectual Property',
            body:
                'All content on the Suppliable platform — including logos, product images, text, and software — is the exclusive property of Suppliable or its licensors. Reproduction, distribution, or commercial use of any content without written permission is strictly prohibited.',
          ),
          _LegalSection(
            title: '9. Limitation of Liability',
            body:
                'To the maximum extent permitted by law, Suppliable shall not be liable for any indirect, incidental, special, or consequential damages arising from the use of or inability to use the platform. Our total liability in any matter shall not exceed the value of the order in question.',
          ),
          _LegalSection(
            title: '10. Governing Law',
            body:
                'These Terms & Conditions are governed by and construed in accordance with the laws of India. Any disputes arising shall be subject to the exclusive jurisdiction of courts in New Delhi, India.',
          ),
          _LegalSection(
            title: '11. Contact',
            body:
                'For questions regarding these terms, reach us at:\n\nEmail: legal@suppliable.in\nPhone: +91 98765 43210\nAddress: Suppliable Technologies Pvt. Ltd., Okhla Industrial Area, Phase III, New Delhi – 110020',
          ),
          SizedBox(height: 32),
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
