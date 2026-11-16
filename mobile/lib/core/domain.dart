import 'dart:math' show max, min;

import 'status.dart';

/// Скільки точок ряду тримає графік; решта обрізається з початку.
const maxChartPoints = 2000;

/// Вікно графіка, коли словник не каже іншого, секунд.
const defaultWindowSec = 3600;

/// Конфігурація метрики: підпис, одиниця, період звітування, пороги і
/// вікно графіка. Той самий зміст, що в client/domain.js розділу 4. Вікно
/// з кількістю точок понад [maxChartPoints] не компілюється: ряд мовчки
/// обрізав би початок, і графік показував би менше, ніж обіцяє підпис.
class MetricSpec {
  const MetricSpec(
    this.label,
    this.unit,
    this.periodSec, {
    this.rule,
    this.decimals = 1,
    this.windowSec = defaultWindowSec,
  }) : assert(
         windowSec <= maxChartPoints * periodSec,
         'у вікні графіка більше точок, ніж тримає ряд',
       );

  final String label;
  final String unit;
  final int periodSec;
  final Rule? rule;
  final int decimals;

  /// Скільки історії показує графік, секунд.
  final int windowSec;

  Duration get window => Duration(seconds: windowSec);
}

/// Метрика, яку екран пристрою малює, коли посилання не називає іншої.
const primaryMetric = 'soil_moisture';

/// Метрики домену. Для іншого домену змінюється цей словник (підписи,
/// одиниці, періоди, пороги, вікна), а не екрани. Дії на кшталт поливу
/// живуть в екрані пристрою й у таблиці строків `defaultMaxAge`.
const greenhouse = <String, MetricSpec>{
  'soil_moisture': MetricSpec(
    'Вологість ґрунту',
    '%',
    60,
    rule: Rule(Direction.below, warn: 35, crit: 30),
  ),
  'temperature': MetricSpec(
    'Температура повітря',
    '°C',
    60,
    rule: Rule(Direction.above, warn: 32, crit: 35),
    windowSec: 6 * 3600,
  ),
  'humidity': MetricSpec('Вологість повітря', '%', 60),
  'light': MetricSpec('Освітленість', 'лк', 60, decimals: 0),
};

/// Найкоротший період звітування серед метрик: пристрій, що мовчить довше
/// за три такі періоди, у списку вважається таким, що не на зв’язку.
final devicePeriodSec = greenhouse.values
    .map((s) => s.periodSec)
    .reduce(min);

/// Як часто екран перераховує вік даних, коли нових даних немає: шоста
/// частина періоду, не рідше за секунду. Мовчання виявляється із запізненням
/// не більше за 1/18 порога «Немає даних» (3 · T), а для T = 60 с крок —
/// ті самі 10 с, що в `useNow` вебдашборда.
Duration tickFor(int periodSec) =>
    Duration(seconds: max(1, periodSec ~/ 6));

final statusTick = tickFor(devicePeriodSec);
