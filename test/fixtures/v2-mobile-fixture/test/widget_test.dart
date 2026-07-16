import 'package:flutter_test/flutter_test.dart';
import 'package:proof/main.dart';

void main() {
  testWidgets('fixture reaches the final Android proof state', (tester) async {
    await tester.pumpWidget(const ProofFixtureApp());

    expect(find.text('Fixture awaiting activation'), findsOneWidget);
    await tester.tap(find.text('Activate proof'));
    await tester.pump();

    expect(find.text('Android proof ready'), findsOneWidget);
    expect(find.text('Proof activated'), findsOneWidget);
  });
}
