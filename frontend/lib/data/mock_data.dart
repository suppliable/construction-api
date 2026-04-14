// lib/data/mock_data.dart
// 30 realistic construction-material products for Suppliable

import '../models/app_state.dart';

// ── Categories ────────────────────────────────────────────────────────────────

const List<Map<String, String>> kCategories = [
  {'id': 'cement',        'name': 'Cement',        'icon': '🏗️', 'sub': '7 Brands'},
  {'id': 'steel',         'name': 'Steel',         'icon': '⛓️', 'sub': '4 Brands'},
  {'id': 'waterproofing', 'name': 'Waterproofing', 'icon': '💧', 'sub': 'Dr. Fixit'},
  {'id': 'paints',        'name': 'Paints',        'icon': '🎨', 'sub': 'Asian Paints'},
  {'id': 'pipes',         'name': 'Pipes',         'icon': '🚰', 'sub': 'Astral'},
  {'id': 'electrical',    'name': 'Electrical',    'icon': '⚡', 'sub': 'Polycab'},
];

// ── Image helpers ─────────────────────────────────────────────────────────────

const _imgCement = 'https://images.unsplash.com/photo-1589939705384-5185137a7f0f?w=400&fit=crop&q=80';
const _imgSteel1 = 'https://images.unsplash.com/photo-1504328345606-18bbc8c9d7d1?w=400&fit=crop&q=80';
const _imgSteel2 = 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=400&fit=crop&q=80';
const _imgWater  = 'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?w=400&fit=crop&q=80';
const _imgPaint  = 'https://images.unsplash.com/photo-1562591176-329309993181?w=400&fit=crop&q=80';
const _imgPipe   = 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&fit=crop&q=80';
const _imgElec   = 'https://images.unsplash.com/photo-1509391366360-2e959784a276?w=400&fit=crop&q=80';

// ── 30 Products ───────────────────────────────────────────────────────────────

final List<Product> kProducts = [

  // ── CEMENT (7) ─────────────────────────────────────────────────────────────

  Product(
    id: 'c1', name: 'Ramco OPC 53 Grade Cement', brand: 'RAMCO',
    category: 'cement', imageUrl: _imgCement, price: 420, stock: 500,
    description:
        'Ramco OPC 53 Grade Cement offers high early strength ideal for RCC structures, '
        'bridges, and high-rise buildings. Superior fineness for smooth surface finish.',
  ),
  Product(
    id: 'c2', name: 'UltraTech PPC Cement', brand: 'ULTRATECH',
    category: 'cement', imageUrl: _imgCement, price: 465, stock: 400,
    description:
        'UltraTech PPC is India\'s No. 1 cement. Excellent workability and long-term '
        'strength. Best for masonry, plastering and block work.',
  ),
  Product(
    id: 'c3', name: 'ACC Gold PPC Cement', brand: 'ACC',
    category: 'cement', imageUrl: _imgCement, price: 450, stock: 350,
    description:
        'ACC Gold premium Portland Pozzolana Cement — superior strength, durability and '
        'resistance to sulfates and chlorides. Ideal for foundations.',
  ),
  Product(
    id: 'c4', name: 'Ambuja Plus Cement', brand: 'AMBUJA',
    category: 'cement', imageUrl: _imgCement, price: 460, stock: 300,
    description:
        'Ambuja Plus cement with moisture-free technology for stronger walls. '
        'Higher fineness than ordinary cement; excellent setting time.',
  ),
  Product(
    id: 'c5', name: 'Birla Gold Cement', brand: 'BIRLA',
    category: 'cement', imageUrl: _imgCement, price: 455, stock: 250,
    description:
        'Birla Gold PPC cement — superior blaine value, better workability and excellent '
        'sulfate resistance. Suitable for residential construction.',
  ),
  Product(
    id: 'c6', name: 'Dalmia DSP Cement', brand: 'DALMIA',
    category: 'cement', imageUrl: _imgCement, price: 440, stock: 200,
    description:
        'Dalmia DSP Super Cement — 10% extra strength vs ordinary cement. Premium '
        'performance for demanding structures and coastal areas.',
  ),
  Product(
    id: 'c7', name: 'JK Super Cement', brand: 'JK CEMENT',
    category: 'cement', imageUrl: _imgCement, price: 435, stock: 220,
    description:
        'JK Super OPC 53 Grade — consistent quality, high early strength and excellent '
        'durability. Trusted brand across North and Central India.',
  ),

  // ── STEEL / TMT BARS (4 × 4 variants) ─────────────────────────────────────

  Product(
    id: 's1', name: 'ARS TMT Steel Bars', brand: 'ARS STEEL',
    category: 'steel', imageUrl: _imgSteel1,
    description:
        'ARS TMT Fe-500D bars manufactured using Tempcore technology. High strength, '
        'earthquake-resistant with superior elongation. Per 45-kg bundle price.',
    variants: [
      ProductVariant(id: 's1v1', name: '8mm',  price: 580,  stock: 1000),
      ProductVariant(id: 's1v2', name: '10mm', price: 860,  stock: 800),
      ProductVariant(id: 's1v3', name: '16mm', price: 1680, stock: 600),
      ProductVariant(id: 's1v4', name: '25mm', price: 2850, stock: 400),
    ],
  ),
  Product(
    id: 's2', name: 'JSW Neosteel TMT Bars', brand: 'JSW STEEL',
    category: 'steel', imageUrl: _imgSteel2,
    description:
        'JSW Neosteel Fe-500D — engineered for superior earthquake resistance. Uniform '
        'rib pattern, excellent weldability. Widely used in India\'s top projects.',
    variants: [
      ProductVariant(id: 's2v1', name: '8mm',  price: 560,  stock: 900),
      ProductVariant(id: 's2v2', name: '10mm', price: 840,  stock: 700),
      ProductVariant(id: 's2v3', name: '16mm', price: 1650, stock: 500),
      ProductVariant(id: 's2v4', name: '25mm', price: 2780, stock: 300),
    ],
  ),
  Product(
    id: 's3', name: 'Kamdhenu TMT Bars', brand: 'KAMDHENU',
    category: 'steel', imageUrl: _imgSteel1,
    description:
        'Kamdhenu TMT Fe-500D — excellent weldability and superior ductility. '
        'Manufactured with Quench & Self-Temper process for uniform strength.',
    variants: [
      ProductVariant(id: 's3v1', name: '8mm',  price: 540,  stock: 800),
      ProductVariant(id: 's3v2', name: '10mm', price: 810,  stock: 600),
      ProductVariant(id: 's3v3', name: '16mm', price: 1590, stock: 400),
      ProductVariant(id: 's3v4', name: '25mm', price: 2700, stock: 200),
    ],
  ),
  Product(
    id: 's4', name: 'TATA Tiscon TMT Bars', brand: 'TATA STEEL',
    category: 'steel', imageUrl: _imgSteel2,
    description:
        'TATA Tiscon SD — SuperDuctile TMT bars with 3× more ductility. '
        'Premium grade for seismic zones. Trusted by India\'s leading builders.',
    variants: [
      ProductVariant(id: 's4v1', name: '8mm',  price: 590,  stock: 700),
      ProductVariant(id: 's4v2', name: '10mm', price: 875,  stock: 550),
      ProductVariant(id: 's4v3', name: '16mm', price: 1720, stock: 350),
      ProductVariant(id: 's4v4', name: '25mm', price: 2900, stock: 180),
    ],
  ),

  // ── WATERPROOFING (4) ──────────────────────────────────────────────────────

  Product(
    id: 'w1', name: 'Dr. Fixit LW+ Waterproofing', brand: 'PIDILITE',
    category: 'waterproofing', imageUrl: _imgWater,
    description:
        'Dr. Fixit LW+ — effective waterproofing admixture for concrete and mortar. '
        'Prevents water ingress and protects structures from dampness and leakage.',
    variants: [
      ProductVariant(id: 'w1v1', name: '200ml', price: 145,  stock: 200),
      ProductVariant(id: 'w1v2', name: '1L',    price: 420,  stock: 150),
      ProductVariant(id: 'w1v3', name: '5L',    price: 1850, stock: 80),
    ],
  ),
  Product(
    id: 'w2', name: 'Dr. Fixit Pidicrete URP', brand: 'PIDILITE',
    category: 'waterproofing', imageUrl: _imgWater,
    description:
        'Polymer-modified waterproofing slurry for terraces, basements and bathrooms. '
        'Easy brush application, seamless coating, long-lasting protection.',
    variants: [
      ProductVariant(id: 'w2v1', name: '1L', price: 520,  stock: 120),
      ProductVariant(id: 'w2v2', name: '5L', price: 2200, stock: 60),
    ],
  ),
  Product(
    id: 'w3', name: 'Fosroc Brushbond RFX', brand: 'FOSROC',
    category: 'waterproofing', imageUrl: _imgWater,
    description:
        'Flexible cementitious waterproofing coating from Fosroc. Ideal for below-ground '
        'waterproofing, water-retaining structures and swimming pools.',
    variants: [
      ProductVariant(id: 'w3v1', name: '1L', price: 680,  stock: 90),
      ProductVariant(id: 'w3v2', name: '5L', price: 2900, stock: 40),
    ],
  ),
  Product(
    id: 'w4', name: 'Asian Paints SmartCare Damp Proof', brand: 'ASIAN PAINTS',
    category: 'waterproofing', imageUrl: _imgWater,
    description:
        'Interior waterproofing solution that prevents dampness and moisture seepage '
        'through walls. Alkali-resistant, ideal for bathrooms and kitchens.',
    variants: [
      ProductVariant(id: 'w4v1', name: '1L', price: 580,  stock: 100),
      ProductVariant(id: 'w4v2', name: '4L', price: 1950, stock: 70),
    ],
  ),

  // ── PAINTS (5) ─────────────────────────────────────────────────────────────

  Product(
    id: 'p1', name: 'Asian Paints Tractor Emulsion', brand: 'ASIAN PAINTS',
    category: 'paints', imageUrl: _imgPaint,
    description:
        'Premium interior emulsion with 7-year performance guarantee. Excellent coverage, '
        'smooth finish, easy washability. Available in 2000+ shades.',
    variants: [
      ProductVariant(id: 'p1v1', name: '1L',  price: 850,   stock: 100),
      ProductVariant(id: 'p1v2', name: '4L',  price: 3200,  stock: 80),
      ProductVariant(id: 'p1v3', name: '20L', price: 14500, stock: 30),
    ],
  ),
  Product(
    id: 'p2', name: 'Asian Paints Apex Exterior', brand: 'ASIAN PAINTS',
    category: 'paints', imageUrl: _imgPaint,
    description:
        'Superior exterior emulsion that protects against rain, UV rays and algae. '
        'Ideal for exterior walls in India\'s harsh climate. 6-year guarantee.',
    variants: [
      ProductVariant(id: 'p2v1', name: '1L',  price: 920,   stock: 90),
      ProductVariant(id: 'p2v2', name: '4L',  price: 3450,  stock: 70),
      ProductVariant(id: 'p2v3', name: '20L', price: 15800, stock: 25),
    ],
  ),
  Product(
    id: 'p3', name: 'Berger WeatherCoat Long Life', brand: 'BERGER',
    category: 'paints', imageUrl: _imgPaint,
    description:
        'Weather-resistant exterior paint with 10-year durability. Superior UV protection '
        'and anti-algal properties for a lasting fresh look on exterior walls.',
    variants: [
      ProductVariant(id: 'p3v1', name: '4L',  price: 3600,  stock: 60),
      ProductVariant(id: 'p3v2', name: '20L', price: 16500, stock: 20),
    ],
  ),
  Product(
    id: 'p4', name: 'Nerolac Excel Total Ext.', brand: 'NEROLAC',
    category: 'paints', imageUrl: _imgPaint,
    description:
        'Multi-protection against algae, fungi, and UV rays. 9-year performance '
        'guarantee. Advanced coating technology for Indian weather conditions.',
    variants: [
      ProductVariant(id: 'p4v1', name: '4L',  price: 3400,  stock: 65),
      ProductVariant(id: 'p4v2', name: '20L', price: 15600, stock: 22),
    ],
  ),
  Product(
    id: 'p5', name: 'Dulux WeatherShield Power', brand: 'DULUX',
    category: 'paints', imageUrl: _imgPaint,
    description:
        '100% weatherproof exterior paint with excellent dirt resistance. '
        'Self-cleaning technology keeps walls looking fresh. 10-year guarantee.',
    variants: [
      ProductVariant(id: 'p5v1', name: '4L',  price: 3800,  stock: 55),
      ProductVariant(id: 'p5v2', name: '20L', price: 17200, stock: 18),
    ],
  ),

  // ── PIPES (6) ──────────────────────────────────────────────────────────────

  Product(
    id: 'pi1', name: 'Astral CPVC Pipe 1"', brand: 'ASTRAL',
    category: 'pipes', imageUrl: _imgPipe,
    description:
        'Astral CPVC pipes for hot and cold water supply. Chemical-resistant, '
        'easy to install, suitable for high-pressure applications. BIS certified.',
    variants: [
      ProductVariant(id: 'pi1v1', name: '1m',  price: 280,  stock: 500),
      ProductVariant(id: 'pi1v2', name: '3m',  price: 780,  stock: 350),
      ProductVariant(id: 'pi1v3', name: '6m',  price: 1450, stock: 200),
    ],
  ),
  Product(
    id: 'pi2', name: 'Astral CPVC Pipe 2"', brand: 'ASTRAL',
    category: 'pipes', imageUrl: _imgPipe,
    description:
        'Larger-diameter CPVC pipes for main water lines. UV-stabilised for outdoor '
        'use. Excellent impact resistance and smooth bore for flow efficiency.',
    variants: [
      ProductVariant(id: 'pi2v1', name: '1m', price: 450,  stock: 400),
      ProductVariant(id: 'pi2v2', name: '3m', price: 1250, stock: 280),
      ProductVariant(id: 'pi2v3', name: '6m', price: 2300, stock: 150),
    ],
  ),
  Product(
    id: 'pi3', name: 'Supreme UPVC Pipe 1"', brand: 'SUPREME',
    category: 'pipes', imageUrl: _imgPipe,
    description:
        'Supreme UPVC pipes for plumbing and drainage. High impact resistance, '
        'long service life and safe for potable drinking water applications.',
    variants: [
      ProductVariant(id: 'pi3v1', name: '3m', price: 680,  stock: 300),
      ProductVariant(id: 'pi3v2', name: '6m', price: 1250, stock: 180),
    ],
  ),
  Product(
    id: 'pi4', name: 'Supreme UPVC Pipe 2"', brand: 'SUPREME',
    category: 'pipes', imageUrl: _imgPipe,
    description:
        'Supreme UPVC 2-inch pipes for main lines and drainage. Corrosion-resistant, '
        'chemical-attack resistant. Easy solvent-welded jointing.',
    variants: [
      ProductVariant(id: 'pi4v1', name: '3m', price: 1100, stock: 250),
      ProductVariant(id: 'pi4v2', name: '6m', price: 2050, stock: 130),
    ],
  ),
  Product(
    id: 'pi5', name: 'Finolex UPVC Pipe 1"', brand: 'FINOLEX',
    category: 'pipes', imageUrl: _imgPipe,
    description:
        'Finolex UPVC pipes — ISO certified, lead-free compound. Excellent resistance '
        'to chemicals and UV. Smooth inner bore reduces water pressure loss.',
    variants: [
      ProductVariant(id: 'pi5v1', name: '3m', price: 650,  stock: 280),
      ProductVariant(id: 'pi5v2', name: '6m', price: 1200, stock: 160),
    ],
  ),
  Product(
    id: 'pi6', name: 'Finolex UPVC Pipe 2"', brand: 'FINOLEX',
    category: 'pipes', imageUrl: _imgPipe,
    description:
        'Finolex 2-inch UPVC pipes for larger plumbing runs. Lead-free, RoHS compliant. '
        'Long-lasting alternative to GI pipes for construction projects.',
    variants: [
      ProductVariant(id: 'pi6v1', name: '3m', price: 1050, stock: 220),
      ProductVariant(id: 'pi6v2', name: '6m', price: 1980, stock: 110),
    ],
  ),

  // ── ELECTRICAL (4) ─────────────────────────────────────────────────────────

  Product(
    id: 'e1', name: 'Havells FRLS FR Cable', brand: 'HAVELLS',
    category: 'electrical', imageUrl: _imgElec,
    description:
        'Havells FRLS copper cable with superior conductivity and safety. Flame-retardant, '
        'heat-resistant for all domestic and commercial electrical applications.',
    variants: [
      ProductVariant(id: 'e1v1', name: '1.5 sq mm – 90m', price: 1850, stock: 200),
      ProductVariant(id: 'e1v2', name: '2.5 sq mm – 90m', price: 2850, stock: 160),
      ProductVariant(id: 'e1v3', name: '4 sq mm – 90m',   price: 4200, stock: 100),
    ],
  ),
  Product(
    id: 'e2', name: 'Polycab FRLS Wire', brand: 'POLYCAB',
    category: 'electrical', imageUrl: _imgElec,
    description:
        'Polycab FRLS wires with superior insulation and conductivity. ISI certified '
        'for safe and reliable electrical installations across India.',
    variants: [
      ProductVariant(id: 'e2v1', name: '1.5 sq mm – 100m', price: 2100, stock: 180),
      ProductVariant(id: 'e2v2', name: '2.5 sq mm – 100m', price: 3200, stock: 140),
      ProductVariant(id: 'e2v3', name: '4 sq mm – 100m',   price: 4800, stock: 90),
    ],
  ),
  Product(
    id: 'e3', name: 'Finolex FR PVC Wire', brand: 'FINOLEX',
    category: 'electrical', imageUrl: _imgElec,
    description:
        'Finolex FR PVC insulated copper wires for domestic and industrial use. '
        'Known for quality insulation, safety and extra-long service life.',
    variants: [
      ProductVariant(id: 'e3v1', name: '1.5 sq mm – 90m', price: 1950, stock: 170),
      ProductVariant(id: 'e3v2', name: '2.5 sq mm – 90m', price: 2950, stock: 130),
      ProductVariant(id: 'e3v3', name: '4 sq mm – 90m',   price: 4400, stock: 85),
    ],
  ),
  Product(
    id: 'e4', name: 'Anchor Roma Switch Board', brand: 'ANCHOR',
    category: 'electrical', imageUrl: _imgElec,
    description:
        'Anchor by Panasonic Roma modular switch boards. Robust polycarbonate housing, '
        'anti-rust concealed screws. Universal fit for all standard boxes.',
    variants: [
      ProductVariant(id: 'e4v1', name: '4-Module – 5 pcs',  price: 450,  stock: 300),
      ProductVariant(id: 'e4v2', name: '4-Module – 10 pcs', price: 850,  stock: 200),
      ProductVariant(id: 'e4v3', name: '6-Module – 5 pcs',  price: 620,  stock: 150),
    ],
  ),
];
