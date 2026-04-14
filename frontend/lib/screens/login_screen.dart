// lib/screens/login_screen.dart
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../widgets/shared.dart';
import '../main.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _phoneCtrl = TextEditingController();
  final _otpCtrl = TextEditingController();
  bool _otpSent = false;
  bool _loading = false;

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _otpCtrl.dispose();
    super.dispose();
  }

  void _sendOtp() {
    if (_phoneCtrl.text.length < 10) return;
    setState(() => _loading = true);
    Future.delayed(const Duration(milliseconds: 800), () {
      if (mounted) setState(() { _loading = false; _otpSent = true; });
    });
  }

  void _verifyOtp() {
    if (_otpCtrl.text.length < 4) return;
    setState(() => _loading = true);
    Future.delayed(const Duration(milliseconds: 600), () {
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(builder: (_) => const MainShell()),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 48),
              // Brand
              SuppliableLogo(size: 24, onLight: true),
              const SizedBox(height: 56),
              // Headline
              const Text(
                'Welcome',
                style: TextStyle(
                  fontSize: 32,
                  fontWeight: FontWeight.w900,
                  color: kSlate900,
                  height: 1.1,
                  letterSpacing: -1,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                'Sign in to manage your construction supply orders.',
                style: TextStyle(
                  fontSize: 14,
                  color: kSlate400,
                  fontWeight: FontWeight.w500,
                  height: 1.5,
                ),
              ),
              const SizedBox(height: 48),

              // Phone field
              _FieldLabel('Mobile Number'),
              const SizedBox(height: 8),
              Container(
                decoration: BoxDecoration(
                  color: kSlate50,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: _otpSent ? kPrimary : kSlate200),
                ),
                child: Row(
                  children: [
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      child: Text(
                        '+91',
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w900,
                          color: kSlate900,
                        ),
                      ),
                    ),
                    Container(width: 1, height: 24, color: kSlate200),
                    Expanded(
                      child: TextField(
                        controller: _phoneCtrl,
                        keyboardType: TextInputType.phone,
                        inputFormatters: [
                          FilteringTextInputFormatter.digitsOnly,
                          LengthLimitingTextInputFormatter(10),
                        ],
                        enabled: !_otpSent,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w700,
                          color: kSlate900,
                          letterSpacing: 1,
                        ),
                        decoration: const InputDecoration(
                          hintText: '98765 43210',
                          hintStyle: TextStyle(
                            color: kSlate400,
                            fontWeight: FontWeight.w500,
                            letterSpacing: 1,
                          ),
                          border: InputBorder.none,
                          contentPadding:
                              EdgeInsets.symmetric(horizontal: 16, vertical: 18),
                        ),
                        onChanged: (_) => setState(() {}),
                      ),
                    ),
                  ],
                ),
              ),

              if (_otpSent) ...[
                const SizedBox(height: 20),
                _FieldLabel('Enter OTP'),
                const SizedBox(height: 8),
                Container(
                  decoration: BoxDecoration(
                    color: kSlate50,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: kSlate200),
                  ),
                  child: TextField(
                    controller: _otpCtrl,
                    keyboardType: TextInputType.number,
                    inputFormatters: [
                      FilteringTextInputFormatter.digitsOnly,
                      LengthLimitingTextInputFormatter(6),
                    ],
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 22,
                      fontWeight: FontWeight.w900,
                      color: kSlate900,
                      letterSpacing: 8,
                    ),
                    decoration: const InputDecoration(
                      hintText: '• • • • • •',
                      hintStyle: TextStyle(
                        color: kSlate400,
                        fontSize: 18,
                        letterSpacing: 6,
                      ),
                      border: InputBorder.none,
                      contentPadding:
                          EdgeInsets.symmetric(horizontal: 16, vertical: 18),
                    ),
                    onChanged: (_) => setState(() {}),
                  ),
                ),
                const SizedBox(height: 8),
                Align(
                  alignment: Alignment.centerRight,
                  child: GestureDetector(
                    onTap: () => setState(() => _otpSent = false),
                    child: const Text(
                      'Change number',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        color: kPrimary,
                      ),
                    ),
                  ),
                ),
              ],

              const SizedBox(height: 32),

              // CTA button
              PrimaryButton(
                label: _otpSent ? 'VERIFY & CONTINUE' : 'SEND OTP',
                loading: _loading,
                icon: _otpSent ? Icons.verified_outlined : Icons.send_outlined,
                color: kPrimary,
                onTap: _otpSent ? _verifyOtp : _sendOtp,
              ),

              const SizedBox(height: 24),

              // Terms note
              Center(
                child: Text(
                  'By continuing, you agree to our Terms & Privacy Policy',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: 11,
                    color: kSlate400,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
              const SizedBox(height: 40),

              // Feature badges
              _FeatureBadges(),
            ],
          ),
        ),
      ),
    );
  }
}

class _FieldLabel extends StatelessWidget {
  final String text;
  const _FieldLabel(this.text);

  @override
  Widget build(BuildContext context) {
    return Text(
      text.toUpperCase(),
      style: const TextStyle(
        fontSize: 10,
        fontWeight: FontWeight.w900,
        color: kSlate400,
        letterSpacing: 2,
      ),
    );
  }
}

class _FeatureBadges extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final items = [
      (Icons.local_shipping_outlined, 'Fast Delivery'),
      (Icons.verified_outlined, 'ISI Certified'),
      (Icons.support_agent_outlined, 'Bulk Orders'),
    ];
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
      children: items.map((e) {
        return Column(
          children: [
            Container(
              width: 48,
              height: 48,
              decoration: BoxDecoration(
                color: kSlate50,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: kSlate100),
              ),
              child: Icon(e.$1, size: 22, color: kPrimary),
            ),
            const SizedBox(height: 6),
            Text(
              e.$2,
              style: const TextStyle(
                fontSize: 10,
                fontWeight: FontWeight.w700,
                color: kSlate600,
              ),
            ),
          ],
        );
      }).toList(),
    );
  }
}
