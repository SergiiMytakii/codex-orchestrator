import 'package:flutter/material.dart';

void main() => runApp(const ProofFixtureApp());

class ProofFixtureApp extends StatelessWidget {
  const ProofFixtureApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'Android Proof Fixture',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xff3f51b5)),
        useMaterial3: true,
      ),
      home: const ProofFixtureScreen(),
    );
  }
}

class ProofFixtureScreen extends StatefulWidget {
  const ProofFixtureScreen({super.key});

  @override
  State<ProofFixtureScreen> createState() => _ProofFixtureScreenState();
}

class _ProofFixtureScreenState extends State<ProofFixtureScreen> {
  bool ready = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Android Proof Fixture')),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Icon(Icons.verified_user_outlined, size: 72),
                  const SizedBox(height: 24),
                  Text(
                    ready ? 'Android proof ready' : 'Fixture awaiting activation',
                    key: const ValueKey('proof-state'),
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.headlineMedium,
                  ),
                  const SizedBox(height: 12),
                  Text(
                    ready
                        ? 'The leased workflow reached its final state.'
                        : 'Activate the fixture to produce final Android evidence.',
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 32),
                  Semantics(
                    button: true,
                    label: 'Activate proof',
                    child: FilledButton(
                      onPressed: ready ? null : () => setState(() => ready = true),
                      child: Text(ready ? 'Proof activated' : 'Activate proof'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
