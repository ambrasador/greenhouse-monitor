// M12: ширина тексту стану в рядку черги на екрані 360 × 640 dp.
//   flutter test tool/m12_layout_test.dart
// Порівнює два шрифти (Ahem — шрифт `flutter test` за замовчуванням; Roboto
// з test/fonts) і два розташування кнопок: «до» — у trailing плитки, «після» —
// під текстом (так зроблено в QueuePanel). Друкує рядки `M12 {json}`.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:greenhouse_mobile/core/api_client.dart';
import 'package:greenhouse_mobile/core/clock.dart';
import 'package:greenhouse_mobile/core/offline_queue.dart';
import 'package:greenhouse_mobile/core/store.dart';
import 'package:greenhouse_mobile/ui/device_detail_screen.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import '../test/fonts/load_roboto.dart';

/// Стани й тексти — ті самі, що в QueuePanel.
const _states = <(String, String, List<String>)>[
  ('pending', 'Очікує відправлення · спроб: 2', ['Надіслати зараз']),
  (
    'conflict',
    'Конфлікт: на сервері інші значення ({soil_moisture_min: 40})',
    ['Залишити моє', 'Взяти серверне'],
  ),
  (
    'expired',
    'Строк дії минув без відповіді. Чи виконано дію — невідомо',
    ['Закрити'],
  ),
  ('rejected', 'Сервер відхилив: 422 invalid-params', ['Закрити']),
];

/// «До»: кнопки в trailing плитки, як було в першій версії.
Widget _before() => ListView(
  padding: const EdgeInsets.all(8),
  children: [
    Card(
      child: Column(
        children: [
          for (final (name, text, buttons) in _states)
            ListTile(
              key: ValueKey(name),
              title: const Text('Полив 30 с'),
              subtitle: Text(text),
              trailing: Wrap(
                children: [
                  for (final b in buttons)
                    TextButton(onPressed: () {}, child: Text(b)),
                ],
              ),
            ),
        ],
      ),
    ),
  ],
);

// `flutter test` пересилає лише print, а не stdout
// ignore: avoid_print
void _emit(Map<String, Object?> row) => print('M12 ${jsonEncode(row)}');

void main() {
  final t0 = DateTime.utc(2026, 11, 4, 12);

  Future<Widget> after() async {
    final store = MemoryStore();
    PendingAction act(String name, ActionStatus st, int attempts) {
      final settings = st == ActionStatus.conflict;
      return PendingAction(
        id: name,
        kind: settings ? ActionKind.settings : ActionKind.command,
        deviceId: 'gh1',
        name: settings ? 'settings' : 'irrigate',
        params: settings ? {'soil_moisture_min': 35} : {'duration_sec': 30},
        createdAt: t0,
        expiresAt: t0.add(const Duration(hours: 24)),
        ifMatch: settings ? '"1"' : null,
        status: st,
        attempts: attempts,
        serverCopy: settings ? {'soil_moisture_min': 40} : null,
        serverEtag: settings ? '"2"' : null,
        error: st == ActionStatus.rejected ? '422 invalid-params' : null,
      );
    }

    final acts = [
      act('pending', ActionStatus.pending, 2),
      act('conflict', ActionStatus.conflict, 1),
      act('expired', ActionStatus.expired, 3),
      act('rejected', ActionStatus.rejected, 1),
    ];
    for (var i = 0; i < acts.length; i++) {
      await store.write(
        'q/${'$i'.padLeft(10, '0')}',
        jsonEncode(acts[i].toJson()),
      );
    }
    final api = ApiClient(
      base: Uri.parse('http://bed.test/api/v1/'),
      client: MockClient((r) async => http.Response('{}', 200)),
      clock: ServerClock(ManualClock(t0)),
    );
    final q = OfflineQueue(
      store: store,
      api: api,
      clock: ManualClock(t0),
      newId: () => 'k',
    );
    await q.load();
    return ListView(
      padding: const EdgeInsets.all(8),
      children: [QueuePanel(queue: q, deviceId: 'gh1')],
    );
  }

  Future<void> measure(
    WidgetTester tester, {
    required String font,
    required String layout,
    required Widget body,
  }) async {
    tester.view
      ..physicalSize =
          const Size(1080, 1920) // 360 × 640 dp
      ..devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    addTearDown(tester.platformDispatcher.clearAllTestValues);
    for (final scale in [1.0, 2.0]) {
      tester.platformDispatcher.textScaleFactorTestValue = scale;
      // помилки розкладки збираємо, а не кидаємо: тест міряє, а не перевіряє
      final errors = <String>[];
      final saved = FlutterError.onError;
      FlutterError.onError = (d) =>
          errors.add(d.exceptionAsString().split('\n').first);
      await tester.pumpWidget(
        MaterialApp(
          theme: ThemeData(fontFamily: font),
          home: Scaffold(body: body),
        ),
      );
      await tester.pumpAndSettle();
      for (final (name, text, _) in _states) {
        final prefix = text.split(' ').take(2).join(' ');
        final f = find.textContaining(prefix);
        final size = tester.getSize(f);
        _emit({
          'font': font,
          'layout': layout,
          'scale': scale,
          'state': name,
          'w': double.parse(size.width.toStringAsFixed(0)),
          'h': double.parse(size.height.toStringAsFixed(0)),
        });
      }
      FlutterError.onError = saved;
      _emit({
        'font': font,
        'layout': layout,
        'scale': scale,
        'errors': errors.length,
        if (errors.isNotEmpty) 'first': errors.first,
      });
    }
  }

  testWidgets('Ahem, до', (t) async {
    await measure(t, font: 'Ahem', layout: 'before', body: _before());
  });
  testWidgets('Ahem, після', (t) async {
    await measure(t, font: 'Ahem', layout: 'after', body: await after());
  });

  testWidgets('Roboto, до і після', (t) async {
    await loadRoboto();
    await measure(t, font: 'Roboto', layout: 'before', body: _before());
    await measure(t, font: 'Roboto', layout: 'after', body: await after());
  });
}
