// lib/screens/home_screen.dart
import 'package:flutter/material.dart';
import '../models/app_state.dart';
import '../widgets/shared.dart';
import 'product_screen.dart';

class HomeScreen extends StatefulWidget {
  final AppState appState;
  final VoidCallback onCartChanged;

  const HomeScreen({
    super.key,
    required this.appState,
    required this.onCartChanged,
  });

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final Map<String, ProductVariant?> _selectedVariants = {};
  String _searchQuery = '';
  String _selectedCategory = 'all';
  bool _showToast = false;
  final _searchCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    for (final p in kProducts) {
      if (p.hasVariants) _selectedVariants[p.id] = p.variants.first;
    }
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  List<Product> get _filteredProducts {
    return kProducts.where((p) {
      final matchesCat =
          _selectedCategory == 'all' || p.category == _selectedCategory;
      final q = _searchQuery.toLowerCase();
      final matchesQ = q.isEmpty ||
          p.name.toLowerCase().contains(q) ||
          p.brand.toLowerCase().contains(q) ||
          p.category.toLowerCase().contains(q);
      return matchesCat && matchesQ;
    }).toList();
  }

  void _addToCart(Product product) {
    final variant = _selectedVariants[product.id];
    widget.appState.addToCart(product, variant: variant);
    widget.onCartChanged();
    setState(() => _showToast = true);
    Future.delayed(const Duration(seconds: 2), () {
      if (mounted) setState(() => _showToast = false);
    });
  }

  void _openVariantPicker(Product product) {
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (_) => _VariantPicker(
        product: product,
        selected: _selectedVariants[product.id],
        onSelect: (v) => setState(() => _selectedVariants[product.id] = v),
      ),
    );
  }

  void _goToProduct(Product product) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => ProductScreen(
          product: product,
          appState: widget.appState,
          onCartChanged: widget.onCartChanged,
        ),
      ),
    );
  }

  void _openAddressSheet(BuildContext context) {
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (_) => _AddressPickerSheet(
        appState: widget.appState,
        onSelected: () => setState(() {}),
      ),
    );
  }

  String _categoryName(String id) {
    if (id == 'all') return 'All Products';
    final cat = kCategories.firstWhere(
      (c) => c['id'] == id,
      orElse: () => {'name': id},
    );
    return cat['name'] ?? id;
  }

  @override
  Widget build(BuildContext context) {
    final products = _filteredProducts;
    return Scaffold(
      backgroundColor: Colors.white,
      body: Stack(
        children: [
          CustomScrollView(
            slivers: [
              SliverToBoxAdapter(
                child: _HomeHeader(
                  address: widget.appState.deliveryAddress,
                  searchCtrl: _searchCtrl,
                  onSearch: (q) => setState(() => _searchQuery = q),
                  onAddressTap: () => _openAddressSheet(context),
                ),
              ),
              const SliverToBoxAdapter(child: SizedBox(height: 20)),
              if (_searchQuery.isEmpty && _selectedCategory == 'all')
                SliverToBoxAdapter(child: _BulkBanner()),
              if (_searchQuery.isEmpty && _selectedCategory == 'all')
                const SliverToBoxAdapter(child: SizedBox(height: 24)),
              if (_searchQuery.isEmpty) ...[
                const SliverToBoxAdapter(
                  child: Padding(
                    padding: EdgeInsets.symmetric(horizontal: 16),
                    child: SectionLabel('CATEGORIES'),
                  ),
                ),
                const SliverToBoxAdapter(child: SizedBox(height: 12)),
                SliverToBoxAdapter(
                  child: _CategoriesRow(
                    selected: _selectedCategory,
                    onSelect: (id) =>
                        setState(() => _selectedCategory = id),
                  ),
                ),
                const SliverToBoxAdapter(child: SizedBox(height: 24)),
              ],
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Row(
                    children: [
                      Container(
                        width: 3,
                        height: 14,
                        color: kOrange,
                        margin: const EdgeInsets.only(right: 8),
                      ),
                      SectionLabel(_categoryName(_selectedCategory)
                          .toUpperCase()),
                      const Spacer(),
                      Text(
                        '${products.length} items',
                        style: const TextStyle(
                          fontSize: 10,
                          fontWeight: FontWeight.w700,
                          color: kSlate400,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SliverToBoxAdapter(child: SizedBox(height: 12)),
              products.isEmpty
                  ? const SliverFillRemaining(
                      child: Center(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(Icons.search_off, size: 48, color: kSlate400),
                            SizedBox(height: 12),
                            Text(
                              'No products found',
                              style: TextStyle(
                                color: kSlate400,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ],
                        ),
                      ),
                    )
                  : SliverPadding(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      sliver: SliverGrid.builder(
                        gridDelegate:
                            const SliverGridDelegateWithFixedCrossAxisCount(
                          crossAxisCount: 2,
                          mainAxisSpacing: 12,
                          crossAxisSpacing: 12,
                          childAspectRatio: 0.60,
                        ),
                        itemCount: products.length,
                        itemBuilder: (_, i) {
                          final product = products[i];
                          final variant = _selectedVariants[product.id];
                          final cartItem =
                              widget.appState.cartItemFor(product, variant);
                          return _ProductCard(
                            product: product,
                            selectedVariant: variant,
                            cartItem: cartItem,
                            onTap: () => _goToProduct(product),
                            onVariantTap: product.hasVariants
                                ? () => _openVariantPicker(product)
                                : null,
                            onAdd: () => _addToCart(product),
                            onIncrease: () {
                              widget.appState.updateQty(cartItem!.cartId, 1);
                              widget.onCartChanged();
                              setState(() {});
                            },
                            onDecrease: () {
                              widget.appState.updateQty(cartItem!.cartId, -1);
                              widget.onCartChanged();
                              setState(() {});
                            },
                          );
                        },
                      ),
                    ),
              const SliverToBoxAdapter(child: SizedBox(height: 32)),
            ],
          ),
          if (_showToast)
            Positioned(
              top: MediaQuery.of(context).padding.top + 80,
              left: 16,
              right: 16,
              child: Material(
                color: Colors.transparent,
                child: Container(
                  padding: const EdgeInsets.symmetric(
                      horizontal: 20, vertical: 12),
                  decoration: BoxDecoration(
                    color: kSlate900,
                    borderRadius: BorderRadius.circular(16),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withOpacity(0.2),
                        blurRadius: 16,
                        offset: const Offset(0, 4),
                      ),
                    ],
                  ),
                  child: const Row(
                    children: [
                      Icon(Icons.check_circle_outline,
                          color: Colors.greenAccent, size: 18),
                      SizedBox(width: 10),
                      Text(
                        'Added to Cart',
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w700,
                          color: Colors.white,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

// ── Header ────────────────────────────────────────────────────────────────────

class _HomeHeader extends StatelessWidget {
  final String address;
  final TextEditingController searchCtrl;
  final ValueChanged<String> onSearch;
  final VoidCallback onAddressTap;

  const _HomeHeader({
    required this.address,
    required this.searchCtrl,
    required this.onSearch,
    required this.onAddressTap,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.white,
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      child: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SizedBox(height: 8),
            Row(
              children: [
                // Branded logo
                SuppliableLogo(size: 20, onLight: true),
                const Spacer(),
                // Tappable address chip
                GestureDetector(
                  onTap: onAddressTap,
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 10, vertical: 7),
                    decoration: BoxDecoration(
                      color: kSlate50,
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(color: kSlate200),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.location_on_outlined,
                            size: 13, color: kPrimary),
                        const SizedBox(width: 4),
                        ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 96),
                          child: Text(
                            address.split(',').first,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w700,
                              color: kSlate800,
                            ),
                          ),
                        ),
                        const Icon(Icons.keyboard_arrow_down,
                            size: 14, color: kOrange),
                      ],
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),
            Container(
              height: 48,
              decoration: BoxDecoration(
                color: kSlate50,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: kSlate200),
              ),
              child: TextField(
                controller: searchCtrl,
                onChanged: onSearch,
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w500,
                  color: kSlate900,
                ),
                decoration: const InputDecoration(
                  hintText: 'Search cement, steel, pipes...',
                  hintStyle: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w500,
                    color: kSlate400,
                  ),
                  prefixIcon:
                      Icon(Icons.search, color: kSlate400, size: 20),
                  border: InputBorder.none,
                  contentPadding: EdgeInsets.symmetric(vertical: 14),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ── Categories row ────────────────────────────────────────────────────────────

class _CategoriesRow extends StatelessWidget {
  final String selected;
  final ValueChanged<String> onSelect;

  const _CategoriesRow({required this.selected, required this.onSelect});

  @override
  Widget build(BuildContext context) {
    final all = [
      {'id': 'all', 'name': 'All', 'icon': '🏠'},
      ...kCategories,
    ];
    return SizedBox(
      height: 84,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        itemCount: all.length,
        separatorBuilder: (_, __) => const SizedBox(width: 10),
        itemBuilder: (_, i) {
          final cat = all[i];
          final isActive = selected == cat['id'];
          return GestureDetector(
            onTap: () => onSelect(cat['id']!),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 200),
              width: 72,
              decoration: BoxDecoration(
                color: isActive ? kPrimary : Colors.white,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(
                  color: isActive ? kPrimary : kSlate200,
                  width: 1.5,
                ),
              ),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(cat['icon']!,
                      style: const TextStyle(fontSize: 22)),
                  const SizedBox(height: 4),
                  Text(
                    cat['name']!,
                    textAlign: TextAlign.center,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 9,
                      fontWeight: FontWeight.w800,
                      color: isActive ? Colors.white : kSlate600,
                      letterSpacing: 0.3,
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

// ── Bulk banner ───────────────────────────────────────────────────────────────

class _BulkBanner extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: kSlate900,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'BULK ORDER',
                  style: TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.w900,
                    color: Colors.white,
                    letterSpacing: -0.5,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  'Lower prices for\nlarge orders',
                  style: TextStyle(
                    fontSize: 11,
                    color: Colors.white.withOpacity(0.5),
                    height: 1.4,
                  ),
                ),
                const SizedBox(height: 14),
                Container(
                  padding: const EdgeInsets.symmetric(
                      horizontal: 16, vertical: 8),
                  decoration: BoxDecoration(
                    color: kOrange,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: const Text(
                    'Get Price',
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w900,
                      color: Colors.white,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const Icon(Icons.local_shipping_outlined,
              size: 80, color: Colors.white12),
        ],
      ),
    );
  }
}

// ── Product card ──────────────────────────────────────────────────────────────

class _ProductCard extends StatelessWidget {
  final Product product;
  final ProductVariant? selectedVariant;
  final CartItem? cartItem;
  final VoidCallback onTap;
  final VoidCallback? onVariantTap;
  final VoidCallback onAdd;
  final VoidCallback onIncrease;
  final VoidCallback onDecrease;

  const _ProductCard({
    required this.product,
    required this.selectedVariant,
    required this.cartItem,
    required this.onTap,
    required this.onVariantTap,
    required this.onAdd,
    required this.onIncrease,
    required this.onDecrease,
  });

  @override
  Widget build(BuildContext context) {
    final price = selectedVariant?.price ?? product.price ?? 0;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: kSlate200),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withOpacity(0.04),
              blurRadius: 8,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ClipRRect(
              borderRadius:
                  const BorderRadius.vertical(top: Radius.circular(17)),
              child: AspectRatio(
                aspectRatio: 1,
                child: ProductImage(url: product.imageUrl),
              ),
            ),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      product.brand,
                      style: const TextStyle(
                        fontSize: 9,
                        fontWeight: FontWeight.w900,
                        color: kSlate400,
                        letterSpacing: 1.2,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      product.name,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        color: kSlate900,
                        height: 1.3,
                      ),
                    ),
                    if (product.hasVariants) ...[
                      const SizedBox(height: 5),
                      GestureDetector(
                        onTap: onVariantTap,
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 8, vertical: 4),
                          decoration: BoxDecoration(
                            color: kSlate50,
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: kSlate100),
                          ),
                          child: Row(
                            children: [
                              Expanded(
                                child: Text(
                                  selectedVariant?.name ?? 'Select',
                                  style: const TextStyle(
                                    fontSize: 10,
                                    fontWeight: FontWeight.w700,
                                    color: kSlate800,
                                  ),
                                ),
                              ),
                              const Icon(Icons.keyboard_arrow_down,
                                  size: 14, color: kOrange),
                            ],
                          ),
                        ),
                      ),
                    ] else
                      const SizedBox(height: 5),
                    const Spacer(),
                    Row(
                      children: [
                        Text(
                          '₹${price.toStringAsFixed(0)}',
                          style: const TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w900,
                            color: kSlate900,
                          ),
                        ),
                        const Spacer(),
                        if (cartItem != null)
                          QtyButton(
                            qty: cartItem!.qty,
                            onIncrease: onIncrease,
                            onDecrease: onDecrease,
                          )
                        else
                          GestureDetector(
                            onTap: onAdd,
                            child: Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 12, vertical: 6),
                              decoration: BoxDecoration(
                                border:
                                    Border.all(color: kOrange, width: 1.5),
                                borderRadius: BorderRadius.circular(9),
                              ),
                              child: const Text(
                                'ADD',
                                style: TextStyle(
                                  fontSize: 10,
                                  fontWeight: FontWeight.w900,
                                  color: kOrange,
                                  letterSpacing: 1,
                                ),
                              ),
                            ),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ── Variant picker ────────────────────────────────────────────────────────────

class _VariantPicker extends StatelessWidget {
  final Product product;
  final ProductVariant? selected;
  final ValueChanged<ProductVariant> onSelect;

  const _VariantPicker({
    required this.product,
    required this.selected,
    required this.onSelect,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.fromLTRB(
          20, 12, 20, MediaQuery.of(context).viewInsets.bottom + 32),
      decoration: const BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 40,
            height: 4,
            margin: const EdgeInsets.only(bottom: 20),
            decoration: BoxDecoration(
              color: kSlate200,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      product.name,
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w900,
                        color: kSlate900,
                      ),
                    ),
                    const Text(
                      'SELECT SIZE / UNIT',
                      style: TextStyle(
                        fontSize: 9,
                        fontWeight: FontWeight.w900,
                        color: kSlate400,
                        letterSpacing: 2,
                      ),
                    ),
                  ],
                ),
              ),
              GestureDetector(
                onTap: () => Navigator.pop(context),
                child: Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    color: kSlate50,
                    shape: BoxShape.circle,
                    border: Border.all(color: kSlate200),
                  ),
                  child: const Icon(Icons.close,
                      size: 18, color: kSlate600),
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          ...product.variants.map((v) {
            final isSelected = selected?.id == v.id;
            return GestureDetector(
              onTap: () {
                onSelect(v);
                Navigator.pop(context);
              },
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 150),
                margin: const EdgeInsets.only(bottom: 10),
                padding: const EdgeInsets.symmetric(
                    horizontal: 16, vertical: 14),
                decoration: BoxDecoration(
                  color: isSelected
                      ? kPrimary.withOpacity(0.06)
                      : Colors.white,
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(
                    color: isSelected ? kPrimary : kSlate100,
                    width: isSelected ? 2 : 1,
                  ),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            v.name,
                            style: TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w800,
                              color:
                                  isSelected ? kPrimary : kSlate900,
                            ),
                          ),
                          Text(
                            'In stock: ${v.stock}',
                            style: const TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.w600,
                              color: kSlate400,
                            ),
                          ),
                        ],
                      ),
                    ),
                    Text(
                      '₹${v.price.toStringAsFixed(0)}',
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w900,
                        color: kSlate900,
                      ),
                    ),
                  ],
                ),
              ),
            );
          }),
        ],
      ),
    );
  }
}

// ── Address picker sheet ──────────────────────────────────────────────────────

class _AddressPickerSheet extends StatefulWidget {
  final AppState appState;
  final VoidCallback onSelected;

  const _AddressPickerSheet({
    required this.appState,
    required this.onSelected,
  });

  @override
  State<_AddressPickerSheet> createState() => _AddressPickerSheetState();
}

class _AddressPickerSheetState extends State<_AddressPickerSheet> {
  @override
  Widget build(BuildContext context) {
    final addresses = widget.appState.addresses;
    final current = widget.appState.deliveryAddress;

    return Container(
      padding: EdgeInsets.fromLTRB(
          20, 12, 20, MediaQuery.of(context).viewInsets.bottom + 24),
      decoration: const BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Drag handle
          Container(
            width: 40,
            height: 4,
            margin: const EdgeInsets.only(bottom: 20),
            decoration: BoxDecoration(
              color: kSlate200,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          // Header
          Row(
            children: [
              const Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Delivery Address',
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w900,
                        color: kSlate900,
                      ),
                    ),
                    Text(
                      'SELECT A DELIVERY SITE',
                      style: TextStyle(
                        fontSize: 9,
                        fontWeight: FontWeight.w900,
                        color: kSlate400,
                        letterSpacing: 2,
                      ),
                    ),
                  ],
                ),
              ),
              GestureDetector(
                onTap: () => Navigator.pop(context),
                child: Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    color: kSlate50,
                    shape: BoxShape.circle,
                    border: Border.all(color: kSlate200),
                  ),
                  child: const Icon(Icons.close, size: 18, color: kSlate600),
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          // Address list
          ...addresses.map((addr) {
            final isSelected = current == addr.address;
            return GestureDetector(
              onTap: () {
                widget.appState.setDeliveryAddress(addr.address);
                widget.onSelected();
                Navigator.pop(context);
              },
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 150),
                margin: const EdgeInsets.only(bottom: 10),
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: isSelected ? kPrimary.withOpacity(0.05) : kSlate50,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(
                    color: isSelected ? kPrimary : kSlate100,
                    width: isSelected ? 2 : 1,
                  ),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 40,
                      height: 40,
                      decoration: BoxDecoration(
                        color: isSelected
                            ? kPrimary.withOpacity(0.1)
                            : Colors.white,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: kSlate100),
                      ),
                      child: Icon(
                        addressTypeIcon(addr.type),
                        size: 20,
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
                                addr.label,
                                style: TextStyle(
                                  fontSize: 13,
                                  fontWeight: FontWeight.w800,
                                  color: isSelected ? kPrimary : kSlate900,
                                ),
                              ),
                              const SizedBox(width: 6),
                              Container(
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 6, vertical: 2),
                                decoration: BoxDecoration(
                                  color: kSlate100,
                                  borderRadius: BorderRadius.circular(5),
                                ),
                                child: Text(
                                  addr.type,
                                  style: const TextStyle(
                                    fontSize: 9,
                                    fontWeight: FontWeight.w700,
                                    color: kSlate400,
                                  ),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 2),
                          Text(
                            addr.address,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 11,
                              color: kSlate400,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ],
                      ),
                    ),
                    if (isSelected)
                      const Icon(Icons.check_circle,
                          color: kPrimary, size: 20),
                  ],
                ),
              ),
            );
          }),
          const SizedBox(height: 4),
          // Add new address button
          GestureDetector(
            onTap: () {
              Navigator.pop(context);
              // Navigate to add address screen via the nearest Navigator
            },
            child: Container(
              height: 48,
              decoration: BoxDecoration(
                border: Border.all(color: kPrimary, width: 1.5),
                borderRadius: BorderRadius.circular(14),
              ),
              child: const Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(Icons.add_location_alt_outlined,
                      size: 18, color: kPrimary),
                  SizedBox(width: 8),
                  Text(
                    'Add New Address',
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w800,
                      color: kPrimary,
                    ),
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
