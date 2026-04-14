import 'package:flutter_test/flutter_test.dart';
import 'package:suppliable/main.dart';

void main() {
  testWidgets('App smoke test', (WidgetTester tester) async {
    await tester.pumpWidget(const SuppliableApp());
    expect(find.byType(SuppliableApp), findsOneWidget);
  });
}
