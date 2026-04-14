# Suppliable — Flutter (Material 3)

B2B building materials ordering app, converted from React to Flutter.

## Project Structure

```
lib/
├── main.dart                    # App entry point + MainShell + BottomNav
├── models/
│   └── app_state.dart           # Data models (Product, CartItem, Order, etc.)
│                                # + AppState (in-memory state, replaces Firebase)
│                                # + kProducts / kCategories mock data
├── widgets/
│   └── shared.dart              # Reusable widgets + design tokens (colors, etc.)
└── screens/
    ├── home_screen.dart         # Home feed, categories, product grid, variant picker
    ├── product_screen.dart      # Product detail + variant selection + qty
    ├── cart_screen.dart         # Material cart + quote summary + checkout trigger
    ├── orders_screen.dart       # Order history list + OrderDetailsScreen
    ├── account_screen.dart      # Account menu + GstDetailsScreen + AddressesScreen
    └── checkout_screen.dart     # Checkout + COD selection + SuccessScreen
```

## Design Tokens (in widgets/shared.dart)

| Token      | Value       | Usage                    |
|------------|-------------|--------------------------|
| kPrimary   | #3B2CD3     | Brand blue/violet        |
| kOrange    | #FA7713     | CTA buttons, accents     |
| kSlate900  | #0F172A     | Headings, dark buttons   |
| kSlate400  | #94A3B8     | Muted text, icons        |
| kSlate100  | #F1F5F9     | Card borders             |
| kSlate50   | #F8FAFC     | Background fills         |

## Key Decisions

- **State**: `AppState extends ChangeNotifier` replaces Firebase/Firestore.
  Wrap `MainShell` in a `ChangeNotifierProvider` (add `provider` to pubspec)
  for reactive rebuilds across tabs, or call `setState` from parent as done here.

- **Navigation**: Each sub-screen (ProductScreen, OrderDetailsScreen, etc.)
  uses `Navigator.push` rather than tab switching, matching the React router pattern.

- **Firebase**: Removed. Add `firebase_core`, `firebase_auth`, `cloud_firestore`
  to pubspec and replace `AppState` methods with Firestore calls to restore it.

## Getting Started

```bash
flutter pub get
flutter run
```

For production, add the Inter font via Google Fonts package or as an asset,
and wire up Firebase per `pubspec.yaml` comments.
