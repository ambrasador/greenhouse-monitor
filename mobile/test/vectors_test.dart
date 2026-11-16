// Вектори згенеровано кодом JavaScript із розділу 4 (tool/gen_vectors.mjs).
// Dart-порт має повторити його відповіді до одиниці.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:greenhouse_mobile/core/backoff.dart';
import 'package:greenhouse_mobile/core/merge.dart';
import 'package:greenhouse_mobile/core/status.dart';

List<Point> points(List<dynamic> l) => [
  for (final p in l)
    Point((p as List<dynamic>)[0] as int, (p[1] as num).toDouble()),
];

Rule? ruleOf(Map<String, dynamic>? r) => r == null
    ? null
    : Rule(
        Direction.values.byName(r['direction'] as String),
        warn: (r['warn'] as num).toDouble(),
        crit: (r['crit'] as num).toDouble(),
      );

void main() {
  final v = jsonDecode(
    File('fixtures/vectors.json').readAsStringSync(),
  ) as Map<String, dynamic>;

  test('evaluateStatus: ${(v['status'] as List).length} векторів', () {
    for (final c in v['status'] as List<dynamic>) {
      final m = c as Map<String, dynamic>;
      final reading = m['ts'] == null
          ? null
          : Reading(
              DateTime.parse(m['ts'] as String),
              m['value'] == null
                  ? double.nan
                  : (m['value'] as num).toDouble(),
            );
      final got = evaluateStatus(
        reading,
        ruleOf(m['rule'] as Map<String, dynamic>?),
        now: DateTime.parse(m['now'] as String),
        periodSec: m['periodSec'] as int,
      );
      expect(got.name, m['expect'], reason: '$m');
    }
  });

  test('mergeSorted: ${(v['merge'] as List).length} векторів', () {
    for (final c in v['merge'] as List<dynamic>) {
      final m = c as Map<String, dynamic>;
      final a = points(m['a'] as List<dynamic>);
      final out = mergeSorted(
        a,
        points(m['b'] as List<dynamic>),
        max: m['max'] as int?,
      );
      expect(out, points(m['expect'] as List<dynamic>), reason: '$m');
      expect(identical(out, a), m['identical'], reason: '$m');
    }
  });

  test('backoffDelay: ${(v['backoff'] as List).length} векторів', () {
    for (final c in v['backoff'] as List<dynamic>) {
      final m = c as Map<String, dynamic>;
      final got = backoffDelay(
        m['attempt'] as int,
        base: Duration(milliseconds: m['baseMs'] as int),
        cap: Duration(milliseconds: m['capMs'] as int),
        rnd: () => (m['rnd'] as num).toDouble(),
      );
      expect(got.inMilliseconds, m['expectMs'], reason: '$m');
    }
  });
}
