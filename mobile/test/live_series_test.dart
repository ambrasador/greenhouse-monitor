import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:greenhouse_mobile/core/api_client.dart';
import 'package:greenhouse_mobile/core/clock.dart';
import 'package:greenhouse_mobile/core/domain.dart' show maxChartPoints;
import 'package:greenhouse_mobile/core/live_series.dart';
import 'package:greenhouse_mobile/core/merge.dart';
import 'package:greenhouse_mobile/core/models.dart';
import 'package:greenhouse_mobile/core/sse_client.dart';

void main() {
  final t0 = DateTime.utc(2026, 11, 4, 12);
  int ms(int minAgo) =>
      t0.subtract(Duration(minutes: minAgo)).millisecondsSinceEpoch;
  SseEvent tel(int minAgo, double v, {String metric = 'soil_moisture'}) {
    final ts = DateTime.fromMillisecondsSinceEpoch(ms(minAgo), isUtc: true);
    return SseEvent(
      'telemetry',
      '{"device":"gh1","metric":"$metric","ts":"${ts.toIso8601String()}","value":$v}',
      null,
    );
  }

  late List<StreamController<SseEvent>> feeds;
  late StreamController<SseEvent> feed; // останній відкритий потік
  late List<(DateTime, DateTime, String?)> calls;
  late List<TelemetryPage> pages;
  late LiveSeries series;
  late List<List<Point>> emitted;

  setUp(() {
    feeds = [];
    calls = [];
    pages = [];
    series = LiveSeries(
      metric: 'soil_moisture',
      open: () {
        feed = StreamController<SseEvent>();
        feeds.add(feed);
        return feed.stream;
      },
      clock: ManualClock(t0),
      history: (from, to, cursor) async {
        calls.add((from, to, cursor));
        return pages.removeAt(0);
      },
    )..start();
    emitted = [];
    series.stream.listen(emitted.add);
  });

  Future<void> settle() => Future<void>.delayed(Duration.zero);

  test(
    'ready → історія за вікно, живі точки зливаються без дублів',
    () async {
      pages.add(TelemetryPage([Point(ms(3), 40), Point(ms(2), 41)], null));
      feed.add(tel(1, 42)); // прийшла до ready — не губиться
      feed.add(const SseEvent('ready', '{}', null));
      feed.add(tel(2, 41)); // дублікат точки з історії
      feed.add(tel(0, 43));
      await settle();
      await settle();
      expect(series.points.map((p) => p.v), [40, 41, 42, 43]);
      expect(calls.single.$1, t0.subtract(const Duration(hours: 1)));
    },
  );

  test('сторінки історії за курсором', () async {
    pages
      ..add(TelemetryPage([Point(ms(5), 1)], 'c1'))
      ..add(TelemetryPage([Point(ms(4), 2)], null));
    feed.add(const SseEvent('ready', '{}', null));
    await settle();
    await settle();
    expect(calls.map((c) => c.$3), [null, 'c1']);
    expect(series.points, hasLength(2));
  });

  test('чужа метрика ігнорується; без змін — без нової події', () async {
    pages.add(TelemetryPage([Point(ms(1), 10)], null));
    feed.add(const SseEvent('ready', '{}', null));
    await settle();
    await settle();
    final before = emitted.length;
    feed.add(tel(0, 99, metric: 'temperature'));
    feed.add(tel(1, 10)); // вже є
    await settle();
    expect(emitted.length, before);
  });

  test(
    'reset: довантаження від останньої точки, не з початку вікна',
    () async {
      pages.add(TelemetryPage([Point(ms(10), 1), Point(ms(9), 2)], null));
      feed.add(const SseEvent('ready', '{}', null));
      await settle();
      await settle();
      pages.add(TelemetryPage([Point(ms(9), 2), Point(ms(1), 7)], null));
      feed.add(const SseEvent('reset', '{}', null));
      feed.add(const SseEvent('ready', '{}', null));
      await settle();
      await settle();
      expect(calls.last.$1.millisecondsSinceEpoch, ms(9));
      expect(series.points.map((p) => p.v), [1, 2, 7]);
    },
  );

  test(
    'reset після паузи довшої за вікно: довантажують лише вікно',
    () async {
      pages.add(
        TelemetryPage([Point(ms(130), 1), Point(ms(125), 2)], null),
      );
      feed.add(const SseEvent('ready', '{}', null));
      await settle();
      await settle();
      pages.add(TelemetryPage([Point(ms(30), 7)], null));
      feed.add(const SseEvent('reset', '{}', null));
      feed.add(const SseEvent('ready', '{}', null));
      await settle();
      await settle();
      expect(
        calls.last.$1,
        t0.subtract(const Duration(hours: 1)),
        reason: 'межа ms(125) старша за вікно: просити від неї марно',
      );
    },
  );

  test('вікно ковзає: старі точки відпадають', () async {
    pages.add(TelemetryPage([Point(ms(59), 1), Point(ms(30), 2)], null));
    feed.add(const SseEvent('ready', '{}', null));
    await settle();
    await settle();
    expect(series.points.map((p) => p.v), [1, 2]);
    feed.add(tel(-5, 9)); // найновіша точка на 5 хв пізніше за t0
    await settle();
    expect(series.points.map((p) => p.v), [
      2,
      9,
    ], reason: 'ms(59) старша за годину');
  });

  test(
    'пауза закриває потік, ряд лишається; назад — новий потік',
    () async {
      pages.add(TelemetryPage([Point(ms(3), 40), Point(ms(2), 41)], null));
      feed.add(const SseEvent('ready', '{}', null));
      await settle();
      await settle();
      final first = feed;

      await series.stop();
      expect(first.hasListener, isFalse, reason: 'підписку скасовано');
      expect(series.points.map((p) => p.v), [40, 41]);

      series.start();
      expect(feeds, hasLength(2));
      feed.add(const SseEvent('ready', '{}', null));
      feed.add(tel(1, 42));
      await settle();
      await settle();
      expect(series.points.map((p) => p.v), [40, 41, 42]);
      expect(
        calls,
        hasLength(1),
        reason: 'без reset історію не довантажують',
      );
    },
  );

  test(
    'помилка потоку іде обробнику, а закритий потік відкривається знову',
    () async {
      final errors = <Object>[];
      final other = LiveSeries(
        metric: 'soil_moisture',
        open: () {
          feed = StreamController<SseEvent>();
          feeds.add(feed);
          return feed.stream;
        },
        history: (from, to, cursor) async => TelemetryPage(const [], null),
        clock: ManualClock(t0),
        onError: errors.add,
      )..start();
      feed.addError(ApiException(status: 401, title: 'потрібен вхід'));
      await feed.close(); // SseClient після 401 закриває потік
      await settle();
      expect(errors.single, isA<ApiException>());

      other.start(); // наприклад, після повернення на екран
      expect(
        feeds,
        hasLength(3),
        reason: 'setUp відкрив перший, other — решту',
      );
      await other.stop();
    },
  );

  test('start() двічі поспіль відкриває один потік', () {
    series.start();
    series.start();
    expect(feeds, hasLength(1));
  });

  test('reset після паузи: довантаження від останньої точки', () async {
    pages.add(TelemetryPage([Point(ms(10), 1), Point(ms(9), 2)], null));
    feed.add(const SseEvent('ready', '{}', null));
    await settle();
    await settle();
    await series.stop();
    series.start();
    pages.add(TelemetryPage([Point(ms(9), 2), Point(ms(1), 7)], null));
    feed.add(const SseEvent('reset', '{}', null));
    feed.add(const SseEvent('ready', '{}', null));
    await settle();
    await settle();
    expect(calls.last.$1.millisecondsSinceEpoch, ms(9));
    expect(series.points.map((p) => p.v), [1, 2, 7]);
  });

  test(
    'вікно, у якому точок більше за ліміт, обрізає початок ряду',
    () async {
      // 30 діб при T = 15 хв — 2 880 точок, а ряд тримає maxChartPoints
      final all = [
        for (var i = 2879; i >= 0; i--)
          Point(ms(i * 15), (2879 - i).toDouble()),
      ];
      final queue = [
        TelemetryPage(all.sublist(0, 1000), 'c1'),
        TelemetryPage(all.sublist(1000, 2000), 'c2'),
        TelemetryPage(all.sublist(2000), null),
      ];
      final c = StreamController<SseEvent>();
      final long = LiveSeries(
        metric: 'volume',
        window: const Duration(days: 30),
        open: () => c.stream,
        clock: ManualClock(t0),
        history: (from, to, cursor) async => queue.removeAt(0),
      )..start();
      c.add(const SseEvent('ready', '{}', null));
      await settle();
      await settle();
      expect(queue, isEmpty, reason: 'усі три сторінки прочитано');
      expect(long.points, hasLength(maxChartPoints));
      final span = Duration(
        milliseconds: long.points.last.t - long.points.first.t,
      );
      expect(span, const Duration(minutes: 15 * (maxChartPoints - 1)));
      expect(
        span,
        lessThan(const Duration(days: 30)),
        reason: 'підпис обіцяє 30 діб, а ряд має 20 діб 19 год 45 хв',
      );
      await long.stop();
    },
  );
}
