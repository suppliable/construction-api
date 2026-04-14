// lib/screens/add_address_screen.dart
import 'package:flutter/material.dart';
import '../models/app_state.dart';
import '../widgets/shared.dart';

class AddAddressScreen extends StatefulWidget {
  final AppState appState;
  const AddAddressScreen({super.key, required this.appState});

  @override
  State<AddAddressScreen> createState() => _AddAddressScreenState();
}

class _AddAddressScreenState extends State<AddAddressScreen> {
  final _labelCtrl = TextEditingController();
  final _addressCtrl = TextEditingController();
  String _type = 'Work';

  @override
  void dispose() {
    _labelCtrl.dispose();
    _addressCtrl.dispose();
    super.dispose();
  }

  bool get _canSave =>
      _labelCtrl.text.trim().isNotEmpty &&
      _addressCtrl.text.trim().isNotEmpty;

  void _save() {
    if (!_canSave) return;
    final addr = DeliveryAddress(
      id: DateTime.now().millisecondsSinceEpoch.toString(),
      label: _labelCtrl.text.trim(),
      address: _addressCtrl.text.trim(),
      type: _type,
    );
    widget.appState.addAddress(addr);
    widget.appState.setDeliveryAddress(addr.address);
    Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final addresses = widget.appState.addresses;
    return Scaffold(
      backgroundColor: kSlate50,
      body: Column(
        children: [
          SuppliableAppBar(
            title: 'Delivery Sites',
            subtitle: 'Manage addresses',
          ),
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Saved addresses
                  if (addresses.isNotEmpty) ...[
                    const SectionLabel('SAVED ADDRESSES'),
                    const SizedBox(height: 10),
                    ...addresses.map((addr) => _AddressTile(
                          address: addr,
                          isSelected:
                              widget.appState.deliveryAddress == addr.address,
                          onSelect: () {
                            widget.appState.setDeliveryAddress(addr.address);
                            setState(() {});
                          },
                          onDelete: addr.id != '1'
                              ? () {
                                  widget.appState.removeAddress(addr.id);
                                  setState(() {});
                                }
                              : null,
                        )),
                    const SizedBox(height: 24),
                  ],
                  // Add new
                  const SectionLabel('ADD NEW ADDRESS'),
                  const SizedBox(height: 12),
                  AppCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        // Type selector
                        const Text(
                          'ADDRESS TYPE',
                          style: TextStyle(
                            fontSize: 9,
                            fontWeight: FontWeight.w900,
                            color: kSlate400,
                            letterSpacing: 2,
                          ),
                        ),
                        const SizedBox(height: 10),
                        Row(
                          children: ['Work', 'Home', 'Site'].map((t) {
                            final isSelected = _type == t;
                            return Padding(
                              padding: const EdgeInsets.only(right: 8),
                              child: GestureDetector(
                                onTap: () => setState(() => _type = t),
                                child: AnimatedContainer(
                                  duration: const Duration(milliseconds: 150),
                                  padding: const EdgeInsets.symmetric(
                                      horizontal: 16, vertical: 8),
                                  decoration: BoxDecoration(
                                    color: isSelected ? kPrimary : kSlate50,
                                    borderRadius: BorderRadius.circular(20),
                                    border: Border.all(
                                      color:
                                          isSelected ? kPrimary : kSlate200,
                                    ),
                                  ),
                                  child: Text(
                                    t,
                                    style: TextStyle(
                                      fontSize: 12,
                                      fontWeight: FontWeight.w700,
                                      color: isSelected
                                          ? Colors.white
                                          : kSlate600,
                                    ),
                                  ),
                                ),
                              ),
                            );
                          }).toList(),
                        ),
                        const SizedBox(height: 20),
                        _InputField(
                          label: 'SITE LABEL',
                          hint: 'e.g. Main Site, Warehouse',
                          controller: _labelCtrl,
                          onChanged: (_) => setState(() {}),
                        ),
                        const SizedBox(height: 14),
                        _InputField(
                          label: 'FULL ADDRESS',
                          hint: 'Plot no, Street, City, PIN',
                          controller: _addressCtrl,
                          maxLines: 3,
                          onChanged: (_) => setState(() {}),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 24),
                  PrimaryButton(
                    label: 'SAVE ADDRESS',
                    icon: Icons.add_location_alt_outlined,
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

// ── Address tile ──────────────────────────────────────────────────────────────

class _AddressTile extends StatelessWidget {
  final DeliveryAddress address;
  final bool isSelected;
  final VoidCallback onSelect;
  final VoidCallback? onDelete;

  const _AddressTile({
    required this.address,
    required this.isSelected,
    required this.onSelect,
    this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onSelect,
      child: Container(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: isSelected ? kPrimary : kSlate100,
            width: isSelected ? 2 : 1,
          ),
        ),
        child: Row(
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: isSelected ? kPrimary.withOpacity(0.08) : kSlate50,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(
                addressTypeIcon(address.type),
                size: 22,
                color: isSelected ? kPrimary : kSlate400,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text(
                        address.label,
                        style: const TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w800,
                          color: kSlate900,
                        ),
                      ),
                      const SizedBox(width: 6),
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 7, vertical: 2),
                        decoration: BoxDecoration(
                          color: kSlate100,
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text(
                          address.type,
                          style: const TextStyle(
                            fontSize: 9,
                            fontWeight: FontWeight.w900,
                            color: kSlate400,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 3),
                  Text(
                    address.address,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 11,
                      color: kSlate400,
                      fontWeight: FontWeight.w500,
                      height: 1.4,
                    ),
                  ),
                ],
              ),
            ),
            if (isSelected)
              const Icon(Icons.check_circle, color: kPrimary, size: 20)
            else if (onDelete != null)
              GestureDetector(
                onTap: onDelete,
                child: const Padding(
                  padding: EdgeInsets.all(4),
                  child:
                      Icon(Icons.delete_outline, size: 20, color: kSlate400),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

// ── Reusable input field ──────────────────────────────────────────────────────

class _InputField extends StatelessWidget {
  final String label;
  final String hint;
  final TextEditingController controller;
  final int maxLines;
  final ValueChanged<String>? onChanged;

  const _InputField({
    required this.label,
    required this.hint,
    required this.controller,
    this.maxLines = 1,
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
        const SizedBox(height: 6),
        Container(
          decoration: BoxDecoration(
            color: kSlate50,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: kSlate200),
          ),
          child: TextField(
            controller: controller,
            maxLines: maxLines,
            onChanged: onChanged,
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w600,
              color: kSlate900,
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
                  horizontal: 14, vertical: 14),
            ),
          ),
        ),
      ],
    );
  }
}
