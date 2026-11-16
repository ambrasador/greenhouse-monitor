import 'dart:async';
import 'dart:convert';

import 'clock.dart';
import 'domain.dart' show defaultWindowSec, maxChartPoints;
import 'merge.dart';
import 'models.dart';
import 'sse_client.dart';

typedef HistoryLoader = Future<TelemetryPage> Function(
  DateTime from,
  DateTime to,
  String? cursor,
);

/// Ряд однієї метрики на екрані: історія за вікно [window] плюс живі точки.
///
/// Порядок з розділу 3: спершу відкрити потік, і лише коли сервер надішле
/// `ready`, довантажити історію; точки, що прийшли в проміжку, не губляться,
/// а повтори зливає `mergeSorted`. Після `reset` (пропуск більший за ліміт
/// повторення на сервері) історію довантажують знову.
///
/// Потік можна закрити ([stop]) і відкрити знову ([start]): ряд лишається
/// в пам’яті, а що пропущено за паузу, сервер повторює за `Last-Event-ID`.
class LiveSeries {
  LiveSeries({
    required this.metric,
    required this.open,
    required this.history,
    required this.clock,
    this.window = const Duration(seconds: defaultWindowSec),
    this.maxPoints = maxChartPoints,
    this.onError,
  });

  final String metric;

  /// Відкриває потік подій заново; щоразу — новий потік.
  final Stream<SseEvent> Function() open;
  final HistoryLoader history;
  final Clock clock;
  final Duration window;
  final int maxPoints;

  /// Помилка потоку, наприклад 401: потік після неї закрито, а що робити
  /// далі (новий токен, повідомлення), вирішує застосунок.
  final void Function(Object error)? onError;

  List<Point> _points = const [];
  bool _loaded = false;
  bool _needBackfill = false;
  int? _gapFrom;
  final _out = StreamController<List<Point>>.broadcast(sync: true);
  StreamSubscription<SseEvent>? _sub;
  Future<void> _chain = Future.value();

  List<Point> get points => _points;
  Stream<List<Point>> get stream => _out.stream;

  /// Відкриває потік. Повторний виклик, поки потік відкритий, нічого не робить.
  void start() {
    // події обробляються по черзі: backfill не змішується з наступною точкою
    _sub ??= open().listen(
      (e) => _chain = _chain.then((_) => _on(e)),
      onError: (Object e, StackTrace _) => onError?.call(e),
      onDone: () => _sub = null, // закритий потік можна відкрити знову
    );
  }

  /// Закриває потік і чекає, доки дообробиться те, що вже прийшло.
  Future<void> stop() async {
    final sub = _sub;
    _sub = null;
    await sub?.cancel();
    await _chain;
  }

  Future<void> _on(SseEvent e) async {
    switch (e.event) {
      case 'reset':
        // межа пропуску — найновіша точка до розриву, а не перша жива
        _gapFrom = _points.isEmpty ? null : _points.last.t;
        _needBackfill = true;
      case 'ready':
        if (!_loaded || _needBackfill) {
          await _backfill();
          _loaded = true;
          _needBackfill = false;
        }
      case 'telemetry':
        final j = jsonDecode(e.data) as Map<String, dynamic>;
        if (j['metric'] != metric) return;
        _apply([
          Point(
            DateTime.parse(j['ts'] as String).millisecondsSinceEpoch,
            (j['value'] as num).toDouble(),
          ),
        ]);
    }
  }

  Future<void> _backfill() async {
    final to = clock.now();
    final floor = to.subtract(window);
    final gap = _gapFrom == null
        ? null
        : DateTime.fromMillisecondsSinceEpoch(_gapFrom!, isUtc: true);
    // межа пропуску, старша за вікно, зайвого не дає: ті точки відпали б
    final from = !_loaded || gap == null || gap.isBefore(floor)
        ? floor
        : gap;
    String? cursor;
    do {
      final page = await history(from, to, cursor);
      _apply(page.points);
      cursor = page.next;
    } while (cursor != null);
  }

  void _apply(List<Point> fresh) {
    if (fresh.isEmpty) return;
    final merged = mergeSorted(_points, fresh, max: maxPoints);
    if (identical(merged, _points)) return;
    final cut = merged.last.t - window.inMilliseconds;
    final start = merged.indexWhere((p) => p.t >= cut);
    _points = start > 0 ? merged.sublist(start) : merged;
    _out.add(_points);
  }
}
