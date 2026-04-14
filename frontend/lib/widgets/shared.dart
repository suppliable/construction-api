// lib/widgets/shared.dart
import 'package:flutter/material.dart';
import 'package:cached_network_image/cached_network_image.dart';

// ── Brand logo widget ─────────────────────────────────────────────────────────
// Replicates the Suppliable wordmark: white text on primary, orange dot on 'i'.

class SuppliableLogo extends StatelessWidget {
  /// Font size for the wordmark text.
  final double size;

  /// When true, renders dark text (for use on light/white backgrounds).
  /// When false (default), renders white text (for use on dark/primary backgrounds).
  final bool onLight;

  const SuppliableLogo({super.key, this.size = 22, this.onLight = false});

  @override
  Widget build(BuildContext context) {
    final textColor = onLight ? kPrimary : Colors.white;
    // Dot radius proportional to font size
    final dotR = size * 0.15;
    // Horizontal offset to sit above the 'i' in "Suppliable" (6th character).
    // At bold weight, 'S'≈0.65x, 'u'≈0.58x, 'p'≈0.6x, 'p'≈0.6x, 'l'≈0.32x → ~2.75x
    final dotLeft = size * 2.75;

    return Stack(
      clipBehavior: Clip.none,
      children: [
        Text(
          'Suppliable',
          style: TextStyle(
            fontSize: size,
            fontWeight: FontWeight.w900,
            color: textColor,
            letterSpacing: -0.3,
            height: 1.0,
          ),
        ),
        // Orange accent dot above the 'i'
        Positioned(
          left: dotLeft,
          top: -dotR * 0.8,
          child: Container(
            width: dotR * 2,
            height: dotR * 2,
            decoration: const BoxDecoration(
              color: kOrange,
              shape: BoxShape.circle,
            ),
          ),
        ),
      ],
    );
  }
}

// ── Design tokens ─────────────────────────────────────────────────────────────

const kPrimary  = Color(0xFF3B2CD3);
const kOrange   = Color(0xFFFA7713);
const kSlate50  = Color(0xFFF8FAFC);
const kSlate100 = Color(0xFFF1F5F9);
const kSlate200 = Color(0xFFE2E8F0);
const kSlate400 = Color(0xFF94A3B8);
const kSlate600 = Color(0xFF475569);
const kSlate800 = Color(0xFF1E293B);
const kSlate900 = Color(0xFF0F172A);

// ── Reusable card ─────────────────────────────────────────────────────────────

class AppCard extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry? padding;
  final double radius;
  final Color? color;
  final Color? borderColor;

  const AppCard({
    super.key,
    required this.child,
    this.padding,
    this.radius = 24,
    this.color,
    this.borderColor,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: color ?? Colors.white,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: borderColor ?? kSlate100),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.04),
            blurRadius: 8,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      padding: padding ?? const EdgeInsets.all(20),
      child: child,
    );
  }
}

// ── Section label ─────────────────────────────────────────────────────────────

class SectionLabel extends StatelessWidget {
  final String text;
  const SectionLabel(this.text, {super.key});

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: const TextStyle(
        fontSize: 10,
        fontWeight: FontWeight.w900,
        color: kSlate400,
        letterSpacing: 2.0,
      ),
    );
  }
}

// ── Brand tag ─────────────────────────────────────────────────────────────────

class BrandTag extends StatelessWidget {
  final String label;
  const BrandTag(this.label, {super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: const Color(0xFFFFF7ED),
        border: Border.all(color: const Color(0xFFFED7AA)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        label,
        style: const TextStyle(
          fontSize: 10,
          fontWeight: FontWeight.w900,
          color: kOrange,
          letterSpacing: 1.5,
        ),
      ),
    );
  }
}

// ── App bar ───────────────────────────────────────────────────────────────────

class SuppliableAppBar extends StatelessWidget implements PreferredSizeWidget {
  final String title;
  final String? subtitle;
  final List<Widget>? actions;
  final bool showBack;

  const SuppliableAppBar({
    super.key,
    required this.title,
    this.subtitle,
    this.actions,
    this.showBack = true,
  });

  @override
  Size get preferredSize => const Size.fromHeight(72);

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.white,
      child: SafeArea(
        bottom: false,
        child: SizedBox(
          height: 72,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(
              children: [
                if (showBack)
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
                      Text(
                        title,
                        style: const TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w900,
                          color: kSlate900,
                          letterSpacing: -0.5,
                        ),
                      ),
                      if (subtitle != null) ...[
                        const SizedBox(height: 2),
                        Text(
                          subtitle!,
                          style: const TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w700,
                            color: kSlate400,
                            letterSpacing: 1.5,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                if (actions != null) ...actions!,
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// ── Primary button ────────────────────────────────────────────────────────────

class PrimaryButton extends StatelessWidget {
  final String label;
  final VoidCallback? onTap;
  final bool loading;
  final IconData? icon;
  final Color? color;

  const PrimaryButton({
    super.key,
    required this.label,
    this.onTap,
    this.loading = false,
    this.icon,
    this.color,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: loading ? null : onTap,
      child: Container(
        height: 56,
        decoration: BoxDecoration(
          color: color ?? kSlate900,
          borderRadius: BorderRadius.circular(20),
        ),
        child: Center(
          child: loading
              ? const SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(
                    strokeWidth: 2.5,
                    color: Colors.white,
                  ),
                )
              : Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (icon != null) ...[
                      Icon(icon, size: 18, color: Colors.white),
                      const SizedBox(width: 8),
                    ],
                    Text(
                      label,
                      style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w900,
                        color: Colors.white,
                        letterSpacing: 1.5,
                      ),
                    ),
                  ],
                ),
        ),
      ),
    );
  }
}

// ── Quantity stepper ──────────────────────────────────────────────────────────

class QtyButton extends StatelessWidget {
  final int qty;
  final VoidCallback onIncrease;
  final VoidCallback onDecrease;
  final bool compact;

  const QtyButton({
    super.key,
    required this.qty,
    required this.onIncrease,
    required this.onDecrease,
    this.compact = true,
  });

  @override
  Widget build(BuildContext context) {
    final btnSize = compact ? 32.0 : 44.0;
    return Container(
      decoration: BoxDecoration(
        color: kOrange,
        borderRadius: BorderRadius.circular(compact ? 12 : 16),
        boxShadow: [
          BoxShadow(
            color: kOrange.withOpacity(0.3),
            blurRadius: 8,
            offset: const Offset(0, 3),
          ),
        ],
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _StepBtn(
            icon: qty <= 1 ? Icons.delete_outline : Icons.remove,
            size: btnSize,
            onTap: onDecrease,
          ),
          SizedBox(
            width: compact ? 26.0 : 36.0,
            child: Text(
              '$qty',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: compact ? 12 : 15,
                fontWeight: FontWeight.w900,
                color: Colors.white,
              ),
            ),
          ),
          _StepBtn(icon: Icons.add, size: btnSize, onTap: onIncrease),
        ],
      ),
    );
  }
}

class _StepBtn extends StatelessWidget {
  final IconData icon;
  final double size;
  final VoidCallback onTap;
  const _StepBtn({required this.icon, required this.size, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: SizedBox(
        width: size,
        height: size,
        child: Icon(icon, size: size * 0.45, color: Colors.white),
      ),
    );
  }
}

// ── Network image with fallback ───────────────────────────────────────────────

class ProductImage extends StatelessWidget {
  final String url;
  final BoxFit fit;
  final double? width;
  final double? height;

  const ProductImage({
    super.key,
    required this.url,
    this.fit = BoxFit.cover,
    this.width,
    this.height,
  });

  @override
  Widget build(BuildContext context) {
    return CachedNetworkImage(
      imageUrl: url,
      fit: fit,
      width: width,
      height: height,
      placeholder: (_, __) => Container(
        color: kSlate100,
        child: const Center(
          child: Icon(Icons.image_outlined, color: kSlate400, size: 32),
        ),
      ),
      errorWidget: (_, __, ___) => Container(
        color: kSlate100,
        child: const Center(
          child: Icon(Icons.inventory_2_outlined, color: kSlate400, size: 32),
        ),
      ),
    );
  }
}

// ── Order status chip ─────────────────────────────────────────────────────────

class StatusChip extends StatelessWidget {
  final String status;
  const StatusChip(this.status, {super.key});

  @override
  Widget build(BuildContext context) {
    final (bg, fg) = _colors(status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: fg.withOpacity(0.3)),
      ),
      child: Text(
        status.toUpperCase(),
        style: TextStyle(
          fontSize: 9,
          fontWeight: FontWeight.w900,
          color: fg,
          letterSpacing: 1.2,
        ),
      ),
    );
  }

  (Color, Color) _colors(String s) {
    switch (s.toLowerCase()) {
      case 'delivered':
        return (const Color(0xFFF0FDF4), const Color(0xFF16A34A));
      case 'on the way':
      case 'dispatched':
        return (const Color(0xFFEFF6FF), const Color(0xFF2563EB));
      case 'processing':
        return (const Color(0xFFFFFBEB), const Color(0xFFD97706));
      case 'confirmed':
        return (const Color(0xFFEDE9FE), kPrimary);
      case 'cancelled':
        return (const Color(0xFFFFF1F2), const Color(0xFFE11D48));
      default:
        return (kSlate100, kSlate600);
    }
  }
}

// ── Summary row ───────────────────────────────────────────────────────────────

class SummaryRow extends StatelessWidget {
  final String label;
  final String value;
  final bool isBold;
  final Color? valueColor;

  const SummaryRow({
    super.key,
    required this.label,
    required this.value,
    this.isBold = false,
    this.valueColor,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(
          label,
          style: TextStyle(
            fontSize: 12,
            fontWeight: isBold ? FontWeight.w900 : FontWeight.w600,
            color: isBold ? kSlate900 : kSlate400,
            letterSpacing: isBold ? 0.5 : 1.0,
          ),
        ),
        Text(
          value,
          style: TextStyle(
            fontSize: isBold ? 16 : 12,
            fontWeight: FontWeight.w900,
            color: valueColor ?? (isBold ? kPrimary : kSlate800),
          ),
        ),
      ],
    );
  }
}

// ── Address icon helper ───────────────────────────────────────────────────────

IconData addressTypeIcon(String type) {
  switch (type.toLowerCase()) {
    case 'home':
      return Icons.home_outlined;
    case 'site':
      return Icons.construction_outlined;
    default:
      return Icons.business_outlined;
  }
}
