import 'dart:io' show HttpDate, HttpException;

/// Час для запиту до API: UTC і не більше трьох знаків після коми.
/// `toIso8601String()` виводить мікросекунди, якщо вони є (а в
/// `DateTime.now()` вони є), і сервер такий рядок відхиляє з 400.
String formatTs(DateTime t) => DateTime.fromMillisecondsSinceEpoch(
  t.millisecondsSinceEpoch,
  isUtc: true,
).toIso8601String();

/// Джерело часу. Код, якому потрібне «зараз», бере його звідси,
/// тому тест керує часом без пауз і без `DateTime.now()`.
abstract interface class Clock {
  DateTime now();
}

class SystemClock implements Clock {
  const SystemClock();

  @override
  DateTime now() => DateTime.now().toUtc();
}

/// Годинник для тестів: стоїть, доки його не посунуть.
class ManualClock implements Clock {
  ManualClock(this._now);

  DateTime _now;

  @override
  DateTime now() => _now;

  void advance(Duration d) => _now = _now.add(d);
}

/// Годинник сервера: час телефона плюс зсув за заголовком `Date`.
///
/// Заголовок має точність до секунди, а відповідь іде мережею, тому зсув
/// оцінюється з похибкою не більшою за RTT/2 + 0,5 с.
class ServerClock implements Clock {
  ServerClock(this._local);

  final Clock _local;
  Duration offset = Duration.zero;

  /// Годинник самого телефона, без поправки.
  Clock get local => _local;

  @override
  DateTime now() => _local.now().add(offset);

  /// [sent] і [received] — час телефона перед відправленням запиту й
  /// після отримання заголовків відповіді.
  void observe(String? dateHeader, DateTime sent, DateTime received) {
    if (dateHeader == null) return;
    final DateTime server;
    try {
      server = HttpDate.parse(dateHeader);
    } on HttpException {
      return; // сміття в заголовку не зсуває годинник
    }
    final middle = sent.add(received.difference(sent) ~/ 2);
    // Date відкидає частку секунди: справжній час у [Date, Date + 1 с)
    final estimate = server.add(const Duration(milliseconds: 500));
    offset = estimate.difference(middle);
  }
}
