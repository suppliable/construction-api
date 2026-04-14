// lib/screens/add_gst_screen.dart
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/app_state.dart';
import '../widgets/shared.dart';

class AddGstScreen extends StatefulWidget {
  final AppState appState;
  const AddGstScreen({super.key, required this.appState});

  @override
  State<AddGstScreen> createState() => _AddGstScreenState();
}

class _AddGstScreenState extends State<AddGstScreen> {
  late final TextEditingController _gstCtrl;
  late final TextEditingController _bizCtrl;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _gstCtrl =
        TextEditingController(text: widget.appState.gstNumber);
    _bizCtrl =
        TextEditingController(text: widget.appState.businessName);
  }

  @override
  void dispose() {
    _gstCtrl.dispose();
    _bizCtrl.dispose();
    super.dispose();
  }

  bool get _canSave =>
      _gstCtrl.text.trim().length >= 15 &&
      _bizCtrl.text.trim().isNotEmpty;

  Future<void> _save() async {
    setState(() => _saving = true);
    await Future.delayed(const Duration(milliseconds: 400));
    widget.appState.saveGstDetails(
      gst: _gstCtrl.text.trim(),
      biz: _bizCtrl.text.trim(),
    );
    if (mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: kSlate50,
      body: Column(
        children: [
          SuppliableAppBar(
            title: 'GST Details',
            subtitle: 'Tax records for invoices',
          ),
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: Column(
                children: [
                  // Info banner
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: kPrimary.withOpacity(0.05),
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(
                          color: kPrimary.withOpacity(0.15)),
                    ),
                    child: Row(
                      children: [
                        Container(
                          width: 40,
                          height: 40,
                          decoration: BoxDecoration(
                            color: Colors.white,
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: const Icon(Icons.verified_user_outlined,
                              size: 22, color: kPrimary),
                        ),
                        const SizedBox(width: 12),
                        const Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'TAX RECORDS',
                                style: TextStyle(
                                  fontSize: 10,
                                  fontWeight: FontWeight.w900,
                                  color: kPrimary,
                                  letterSpacing: 1.5,
                                ),
                              ),
                              SizedBox(height: 2),
                              Text(
                                'Add GST to receive business invoices and claim tax benefits on materials.',
                                style: TextStyle(
                                  fontSize: 11,
                                  fontWeight: FontWeight.w500,
                                  color: kSlate600,
                                  height: 1.4,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 24),
                  // GSTIN field
                  _GstField(
                    label: 'GSTIN (15 DIGITS)',
                    hint: 'e.g. 22AAAAA0000A1Z5',
                    controller: _gstCtrl,
                    inputFormatters: [
                      FilteringTextInputFormatter.allow(
                          RegExp(r'[A-Za-z0-9]')),
                      LengthLimitingTextInputFormatter(15),
                    ],
                    onChanged: (_) => setState(() {}),
                  ),
                  const SizedBox(height: 16),
                  // Business name field
                  _GstField(
                    label: 'REGISTERED BUSINESS NAME',
                    hint: 'Legal business name',
                    controller: _bizCtrl,
                    onChanged: (_) => setState(() {}),
                  ),
                  const SizedBox(height: 12),
                  // Validation indicator
                  if (_gstCtrl.text.isNotEmpty &&
                      _gstCtrl.text.length < 15)
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 12, vertical: 8),
                      decoration: BoxDecoration(
                        color: const Color(0xFFFEF2F2),
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Row(
                        children: const [
                          Icon(Icons.info_outline,
                              size: 14, color: Color(0xFFEF4444)),
                          SizedBox(width: 6),
                          Text(
                            'GSTIN must be exactly 15 characters',
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w600,
                              color: Color(0xFFEF4444),
                            ),
                          ),
                        ],
                      ),
                    ),
                  if (_gstCtrl.text.length == 15)
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 12, vertical: 8),
                      decoration: BoxDecoration(
                        color: const Color(0xFFF0FDF4),
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Row(
                        children: const [
                          Icon(Icons.check_circle_outline,
                              size: 14, color: Color(0xFF16A34A)),
                          SizedBox(width: 6),
                          Text(
                            'GSTIN format looks valid',
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w600,
                              color: Color(0xFF16A34A),
                            ),
                          ),
                        ],
                      ),
                    ),
                  const SizedBox(height: 32),
                  PrimaryButton(
                    label: 'UPDATE GST RECORDS',
                    icon: Icons.save_outlined,
                    loading: _saving,
                    onTap: _canSave ? _save : null,
                    color: _canSave ? kPrimary : kSlate200,
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _GstField extends StatelessWidget {
  final String label;
  final String hint;
  final TextEditingController controller;
  final List<TextInputFormatter>? inputFormatters;
  final ValueChanged<String>? onChanged;

  const _GstField({
    required this.label,
    required this.hint,
    required this.controller,
    this.inputFormatters,
    this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(
            fontSize: 9,
            fontWeight: FontWeight.w900,
            color: kSlate400,
            letterSpacing: 2,
          ),
        ),
        const SizedBox(height: 8),
        Container(
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: kSlate200),
          ),
          child: TextField(
            controller: controller,
            inputFormatters: inputFormatters,
            onChanged: onChanged,
            style: const TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w700,
              color: kSlate900,
              letterSpacing: 0.5,
            ),
            decoration: InputDecoration(
              hintText: hint,
              hintStyle: const TextStyle(
                color: kSlate400,
                fontWeight: FontWeight.w500,
                fontSize: 14,
              ),
              border: InputBorder.none,
              contentPadding: const EdgeInsets.symmetric(
                  horizontal: 16, vertical: 16),
            ),
          ),
        ),
      ],
    );
  }
}
