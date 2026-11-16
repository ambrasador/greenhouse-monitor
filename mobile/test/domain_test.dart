import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:greenhouse_mobile/core/api_client.dart';
import 'package:greenhouse_mobile/core/clock.dart';
import 'package:greenhouse_mobile/core/domain.dart';
import 'package:greenhouse_mobile/main.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  test('вікно кожної метрики словника вміщується в ряд', () {
    for (final e in greenhouse.entries) {
      expect(
        e.value.windowSec,
        lessThanOrEqualTo(maxChartPoints * e.value.periodSec),
        reason: e.key,
      );
    }
  });

  test('вікно, у якому точок більше за ліміт ряду, не створюється', () {
    // 30 діб при T = 900 с — 2 880 точок проти 2 000
    expect(
      () => MetricSpec('Витрата', 'м³', 900, windowSec: 30 * 86400),
      throwsA(isA<AssertionError>()),
    );
    // 2 000 · 900 с = 20 діб 20 год: 20 діб проходить
    final ok = MetricSpec('Витрата', 'м³', 900, windowSec: 20 * 86400);
    expect(ok.window, const Duration(days: 20));
  });

  test(
    '«пристрій мовчить» рахується від найкоротшого періоду словника',
    () {
      expect(devicePeriodSec, 60);
    },
  );

  test(
    'крок перерахунку статусу: шоста частина періоду, не рідше секунди',
    () {
      expect(tickFor(60), const Duration(seconds: 10));
      expect(tickFor(300), const Duration(seconds: 50));
      expect(tickFor(900), const Duration(seconds: 150));
      expect(tickFor(5), const Duration(seconds: 1));
      expect(statusTick, const Duration(seconds: 10));
    },
  );

  test('ряд екрана: метрика з посилання, вікно зі словника', () {
    final clock = ServerClock(ManualClock(DateTime.utc(2026, 11, 4, 12)));
    final client = MockClient((_) async => http.Response('', 500));
    final make = liveSeriesFactory(
      client: client,
      api: ApiClient(
        base: Uri.parse('http://x/api/v1/'),
        client: client,
        clock: clock,
      ),
      clock: clock,
    );
    final main = make('gh1', null);
    expect(main.metric, primaryMetric);
    expect(main.window, const Duration(hours: 1));
    final heat = make('gh1', 'temperature');
    expect(heat.window, greenhouse['temperature']!.window);
    expect(heat.window, const Duration(hours: 6));
    final unknown = make('gh1', 'pressure');
    expect(unknown.window, const Duration(seconds: defaultWindowSec));
  });

  test('словник збігається з client/domain.js розділу 4', () {
    // fixtures/vectors.json пише tool/gen_vectors.mjs з того самого JS-файла
    final v = jsonDecode(
      File('fixtures/vectors.json').readAsStringSync(),
    ) as Map<String, dynamic>;
    final js = v['domain'] as Map<String, dynamic>;
    expect(greenhouse.keys.toSet(), js.keys.toSet());
    for (final e in greenhouse.entries) {
      final j = js[e.key] as Map<String, dynamic>;
      final s = e.value;
      expect(s.label, j['label'], reason: '${e.key}.label');
      expect(s.unit, j['unit'], reason: '${e.key}.unit');
      expect(s.periodSec, j['periodSec'], reason: '${e.key}.periodSec');
      expect(s.decimals, j['decimals'], reason: '${e.key}.decimals');
      final r = j['rule'] as Map<String, dynamic>?;
      expect(s.rule == null, r == null, reason: '${e.key}.rule');
      if (r == null) continue;
      expect(
        s.rule!.direction.name,
        r['direction'],
        reason: '${e.key}.direction',
      );
      expect(
        s.rule!.warn,
        (r['warn'] as num).toDouble(),
        reason: '${e.key}.warn',
      );
      expect(
        s.rule!.crit,
        (r['crit'] as num).toDouble(),
        reason: '${e.key}.crit',
      );
    }
  });
}
