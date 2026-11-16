/// Статус картки: чотири рівні. «Немає даних» — окремий рівень,
/// а не відсутність значення.
enum Level { ok, warning, critical, offline }

const levelLabels = {
  Level.ok: 'Норма',
  Level.warning: 'Попередження',
  Level.critical: 'Критично',
  Level.offline: 'Немає даних',
};

enum Direction { below, above }

class Rule {
  const Rule(this.direction, {required this.warn, required this.crit});

  final Direction direction;
  final double warn;
  final double crit;
}

class Reading {
  const Reading(this.ts, this.value);

  final DateTime ts;
  final double value;
}

/// Старші за 3 періоди звітування вимірювання вважаються застарілими.
const staleAfterPeriods = 3;

bool isFresh(
  DateTime? ts, {
  required DateTime now,
  required int periodSec,
}) {
  if (ts == null) return false;
  return now.difference(ts) <=
      Duration(seconds: staleAfterPeriods * periodSec);
}

Level evaluateStatus(
  Reading? reading,
  Rule? rule, {
  required DateTime now,
  required int periodSec,
}) {
  if (reading == null || !reading.value.isFinite) return Level.offline;
  if (!isFresh(reading.ts, now: now, periodSec: periodSec)) {
    return Level.offline;
  }
  if (rule == null) return Level.ok;
  bool beyond(double limit) => rule.direction == Direction.below
      ? reading.value < limit
      : reading.value > limit;
  if (beyond(rule.crit)) return Level.critical;
  if (beyond(rule.warn)) return Level.warning;
  return Level.ok;
}

/// «щойно», «45 с тому», «3 хв тому»: вік даних для підпису під значенням.
String ageLabel(Duration age) {
  if (age < const Duration(seconds: 5)) return 'щойно';
  if (age < const Duration(minutes: 1)) return '${age.inSeconds} с тому';
  if (age < const Duration(hours: 1)) return '${age.inMinutes} хв тому';
  if (age < const Duration(days: 1)) return '${age.inHours} год тому';
  return '${age.inDays} дн тому';
}

/// «остання година», «останні 15 хв», «останні 6 год», «остання доба»:
/// підпис вікна графіка. Одиниці ті самі, що в [ageLabel]; вікно, що не
/// складається з цілих годин чи діб, називається в менших одиницях
/// («90 хв», а не «1 год»).
String windowLabel(Duration window) {
  if (window == const Duration(hours: 1)) return 'остання година';
  if (window == const Duration(days: 1)) return 'остання доба';
  final min = window.inMinutes;
  if (min < 60 || min % 60 != 0) return 'останні $min хв';
  final h = window.inHours;
  if (h < 24 || h % 24 != 0) return 'останні $h год';
  return 'останні ${window.inDays} дн';
}
