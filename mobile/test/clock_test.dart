import 'dart:io' show HttpDate;
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:greenhouse_mobile/core/clock.dart';
import 'package:greenhouse_mobile/core/status.dart';

void main() {
  final t0 = DateTime.utc(2026, 11, 4, 12);

  test('ManualClock стоїть, доки його не посунуть', () {
    final c = ManualClock(t0);
    expect(c.now(), t0);
    c.advance(const Duration(seconds: 90));
    expect(c.now(), t0.add(const Duration(seconds: 90)));
  });

  test(
    'годинник телефона йде не так: поправка повертає правильний статус',
    () {
      // Справжній час сервера — t0. Телефон спішить або відстає на 7 хв.
      final fresh = Reading(t0.subtract(const Duration(seconds: 20)), 40);
      final stale = Reading(t0.subtract(const Duration(minutes: 10)), 40);
      Level at(DateTime now, Reading r) =>
          evaluateStatus(r, null, now: now, periodSec: 60);

      final fast = ManualClock(t0.add(const Duration(minutes: 7)));
      expect(at(fast.now(), fresh), Level.offline, reason: 'хибна тривога');
      final slow = ManualClock(t0.subtract(const Duration(minutes: 7)));
      expect(at(slow.now(), stale), Level.ok, reason: 'пропущена тривога');

      for (final phone in [fast, slow]) {
        final server = ServerClock(phone)
          ..observe(HttpDate.format(t0), phone.now(), phone.now());
        expect(at(server.now(), fresh), Level.ok);
        expect(at(server.now(), stale), Level.offline);
      }
    },
  );

  test(
    'похибка зсуву не перевищує RTT/2 + 0,5 с (1000 випадкових спроб)',
    () {
      final rnd = Random(7);
      for (var i = 0; i < 1000; i++) {
        final offsetMs = rnd.nextInt(7_200_000) - 3_600_000;
        final rttMs = rnd.nextInt(2000);
        final upMs = rnd.nextInt(rttMs + 1); // скільки з RTT іде до сервера
        final sent = t0.add(Duration(milliseconds: rnd.nextInt(60_000)));
        final received = sent.add(Duration(milliseconds: rttMs));
        // сервер формує заголовок у момент sent + upMs за своїм часом
        final serverNow = sent
            .add(Duration(milliseconds: upMs))
            .add(Duration(milliseconds: offsetMs));
        final clock = ServerClock(ManualClock(sent));
        clock.observe(HttpDate.format(serverNow), sent, received);
        final error = (clock.offset.inMilliseconds - offsetMs).abs();
        expect(
          error,
          lessThanOrEqualTo(rttMs / 2 + 500),
          reason: 'offset=$offsetMs rtt=$rttMs up=$upMs',
        );
      }
    },
  );

  test('сміття й відсутній заголовок зсуву не змінюють', () {
    final c = ServerClock(ManualClock(t0))
      ..offset = const Duration(seconds: 3);
    c.observe(null, t0, t0);
    c.observe('вчора ввечері', t0, t0);
    expect(c.offset, const Duration(seconds: 3));
  });

  test('ageLabel', () {
    expect(ageLabel(const Duration(seconds: 2)), 'щойно');
    expect(ageLabel(const Duration(seconds: 45)), '45 с тому');
    expect(ageLabel(const Duration(minutes: 3, seconds: 59)), '3 хв тому');
    expect(ageLabel(const Duration(hours: 5)), '5 год тому');
    expect(ageLabel(const Duration(days: 2)), '2 дн тому');
    expect(ageLabel(const Duration(seconds: -30)), 'щойно');
  });

  test('windowLabel: ті самі одиниці, що в ageLabel', () {
    expect(windowLabel(const Duration(minutes: 15)), 'останні 15 хв');
    expect(windowLabel(const Duration(minutes: 90)), 'останні 90 хв');
    expect(windowLabel(const Duration(hours: 1)), 'остання година');
    expect(windowLabel(const Duration(hours: 6)), 'останні 6 год');
    expect(windowLabel(const Duration(hours: 36)), 'останні 36 год');
    expect(windowLabel(const Duration(days: 1)), 'остання доба');
    expect(windowLabel(const Duration(days: 20)), 'останні 20 дн');
  });
}
