import 'dart:async';

import 'package:flutter/material.dart';

import '../core/clock.dart';
import '../core/domain.dart';
import '../core/live_series.dart';
import '../core/merge.dart';
import '../core/models.dart';
import '../core/offline_queue.dart';
import '../core/repository.dart';
import '../core/status.dart';
import 'status_view.dart';

String _num(double v, int decimals) =>
    v.toStringAsFixed(decimals).replaceAll('.', ',');

/// Картка метрики: значення, вік даних і статус. Застаріле значення не
/// ховається, а позначається: «Немає даних», «Останнє значення …».
class MetricCard extends StatelessWidget {
  const MetricCard({super.key, required this.latest, required this.now});

  final Latest latest;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final spec = greenhouse[latest.metric];
    final level = spec == null
        ? Level.ok
        : evaluateStatus(
            Reading(latest.ts, latest.value),
            spec.rule,
            now: now,
            periodSec: spec.periodSec,
          );
    final value =
        '${_num(latest.value, spec?.decimals ?? 1)} ${spec?.unit ?? latest.unit ?? ''}';
    final age = ageLabel(now.difference(latest.ts));
    return Card(
      child: ListTile(
        title: Text(spec?.label ?? latest.metric),
        subtitle: Text(
          level == Level.offline
              ? 'Останнє значення: $value · $age'
              : '$value · $age',
        ),
        trailing: StatusLabel(level),
      ),
    );
  }
}

String describe(PendingAction a) => switch ((a.kind, a.name)) {
  (ActionKind.command, 'irrigate') => 'Полив ${a.params['duration_sec']} с',
  (ActionKind.command, 'set_setpoint') =>
    'Уставка ${a.params['metric']} = ${a.params['value']}',
  _ => 'Зміна налаштувань',
};

/// Дії, що чекають відправлення, і їхній стан словами.
class QueuePanel extends StatelessWidget {
  const QueuePanel({
    super.key,
    required this.queue,
    required this.deviceId,
  });

  final OfflineQueue queue;
  final String deviceId;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<QueueEvent>(
      stream: queue.events,
      builder: (context, _) {
        final mine = queue.actions
            .where((a) => a.deviceId == deviceId)
            .toList();
        if (mine.isEmpty) return const SizedBox.shrink();
        return Card(
          child: Column(
            children: [for (final a in mine) _tile(context, a)],
          ),
        );
      },
    );
  }

  Widget _tile(BuildContext context, PendingAction a) {
    final (text, actions) = switch (a.status) {
      ActionStatus.pending => (
        'Очікує відправлення${a.attempts > 0 ? ' · спроб: ${a.attempts}' : ''}',
        [
          TextButton(
            onPressed: () => queue.flush(force: true),
            child: const Text('Надіслати зараз'),
          ),
        ],
      ),
      ActionStatus.conflict => (
        'Конфлікт: на сервері інші значення (${a.serverCopy})',
        [
          TextButton(
            onPressed: () => queue.resolveKeepMine(a.id),
            child: const Text('Залишити моє'),
          ),
          TextButton(
            onPressed: () => queue.dismiss(a.id),
            child: const Text('Взяти серверне'),
          ),
        ],
      ),
      ActionStatus.rejected => (
        'Сервер відхилив: ${a.error}',
        [
          TextButton(
            onPressed: () => queue.dismiss(a.id),
            child: const Text('Закрити'),
          ),
        ],
      ),
      ActionStatus.expired => (
        // жодної спроби не було: на сервер дія не потрапляла, це відомо
        // напевно; після спроб відповідь могла загубитися вже після виконання
        a.attempts == 0
            ? 'Строк дії минув до відправлення. Дію не виконано'
            : 'Строк дії минув без відповіді. Чи виконано дію — невідомо',
        [
          TextButton(
            onPressed: () => queue.dismiss(a.id),
            child: const Text('Закрити'),
          ),
        ],
      ),
    };
    // Кнопки під текстом, а не в trailing: там вони забирають ширину в тексту
    // стану, і на екрані 360 dp «Конфлікт: …» стискався до колонки в 30 dp.
    return Column(
      key: ValueKey(a.id),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ListTile(title: Text(describe(a)), subtitle: Text(text)),
        Padding(
          padding: const EdgeInsets.only(right: 8, bottom: 4),
          child: OverflowBar(
            alignment: MainAxisAlignment.end,
            overflowAlignment: OverflowBarAlignment.end,
            children: actions,
          ),
        ),
      ],
    );
  }
}

class Sparkline extends StatelessWidget {
  const Sparkline({
    super.key,
    required this.points,
    required this.title,
    required this.period,
  });

  final List<Point> points;

  /// Назва метрики для зчитувача з екрана: графік без назви нічого не каже.
  final String title;

  /// Вікно графіка словами, наприклад «остання година».
  final String period;

  @override
  Widget build(BuildContext context) {
    if (points.length < 2) return const SizedBox(height: 80);
    final lo = points.map((p) => p.v).reduce((a, b) => a < b ? a : b);
    final hi = points.map((p) => p.v).reduce((a, b) => a > b ? a : b);
    return Semantics(
      label:
          'Графік «$title», $period: '
          'від ${_num(lo, 1)} до ${_num(hi, 1)}',
      child: CustomPaint(
        size: const Size.fromHeight(80),
        painter: _SparkPainter(
          points,
          lo,
          hi,
          Theme.of(context).colorScheme.primary,
        ),
      ),
    );
  }
}

class _SparkPainter extends CustomPainter {
  _SparkPainter(this.points, this.lo, this.hi, this.color);

  final List<Point> points;
  final double lo;
  final double hi;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final t0 = points.first.t;
    final span = (points.last.t - t0).clamp(1, 1 << 62);
    final range = (hi - lo) == 0 ? 1 : hi - lo;
    final path = Path();
    for (var i = 0; i < points.length; i++) {
      final x = size.width * (points[i].t - t0) / span;
      final y = size.height * (1 - (points[i].v - lo) / range);
      i == 0 ? path.moveTo(x, y) : path.lineTo(x, y);
    }
    canvas.drawPath(
      path,
      Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2,
    );
  }

  @override
  bool shouldRepaint(_SparkPainter old) => !identical(old.points, points);
}

/// Підпис і графік однієї метрики за вікно, яке задано словником домену.
class _Chart extends StatelessWidget {
  const _Chart({required this.series});

  final LiveSeries series;

  @override
  Widget build(BuildContext context) {
    final title = greenhouse[series.metric]?.label ?? series.metric;
    final period = windowLabel(series.window);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 12, 8, 4),
          child: Text(
            '$title, $period',
            style: Theme.of(context).textTheme.labelLarge,
          ),
        ),
        StreamBuilder<List<Point>>(
          stream: series.stream,
          initialData: series.points,
          builder: (_, s) => Sparkline(
            points: s.data ?? const [],
            title: title,
            period: period,
          ),
        ),
      ],
    );
  }
}

class DeviceDetailScreen extends StatefulWidget {
  const DeviceDetailScreen({
    super.key,
    required this.repo,
    required this.queue,
    required this.clock,
    required this.deviceId,
    this.metric,
    this.liveFor,
  });

  final DeviceRepository repo;
  final OfflineQueue queue;
  final Clock clock;
  final String deviceId;

  /// Метрика з маршруту (`?metric=` у посиланні зі сповіщення); `null` —
  /// метрика графіка за замовчуванням, її обирає фабрика.
  final String? metric;

  /// Створює ряд метрики для графіка; екран відкриває його потік, поки
  /// застосунок на екрані, і закриває у фоні. Без фабрики графіка немає.
  final LiveSeries Function(String deviceId, String? metric)? liveFor;

  @override
  State<DeviceDetailScreen> createState() => _DeviceDetailScreenState();
}

class _DeviceDetailScreenState extends State<DeviceDetailScreen>
    with WidgetsBindingObserver, TickingState<DeviceDetailScreen> {
  late final Stream<Loaded<DeviceInfo>> _stream = widget.repo.watchDevice(
    widget.deviceId,
  );
  late final LiveSeries? _series = widget.liveFor?.call(
    widget.deviceId,
    widget.metric,
  );

  StreamSubscription<List<Point>>? _points;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // нова точка ряду змінює картку тієї ж метрики, не чекаючи кроку таймера
    _points = _series?.stream.listen((_) => setState(() {}));
    _series?.start();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    unawaited(_points?.cancel());
    unawaited(_series?.stop());
    super.dispose();
  }

  /// Картка метрики, яку малює графік, показує свіжіше з двох: відповідь
  /// сервера при відкритті екрана або остання жива точка ряду. Інші картки
  /// не оновлюються (одного запиту при відкритті для них досить, поки
  /// не минуть три періоди), тож з віком стають «Немає даних».
  Latest _fresher(Latest l) {
    final s = _series;
    if (s == null || s.metric != l.metric || s.points.isEmpty) return l;
    final p = s.points.last;
    if (p.t <= l.ts.millisecondsSinceEpoch) return l;
    return Latest(
      l.metric,
      DateTime.fromMillisecondsSinceEpoch(p.t, isUtc: true),
      p.v,
      l.unit,
    );
  }

  /// У фон — закрити потік: система все одно заморозить сокет, а сервер
  /// тримав би слот. Назад — відкрити; пропущене повторить сервер.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.paused:
        unawaited(_series?.stop());
      case AppLifecycleState.resumed:
        _series?.start();
        setState(() {}); // вік даних рахується заново, не чекаючи кроку
      case AppLifecycleState.inactive ||
          AppLifecycleState.hidden ||
          AppLifecycleState.detached:
        break; // перехідні стани: екран може одразу повернутися
    }
  }

  Future<void> _irrigate() async {
    await widget.queue.enqueueCommand(widget.deviceId, 'irrigate', {
      'duration_sec': 30,
    });
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text(
          'Полив поставлено в чергу. Він піде, якщо зв’язок '
          'з’явиться протягом 5 хв',
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<Loaded<DeviceInfo>>(
      stream: _stream,
      builder: (context, snap) {
        final loaded = snap.data;
        final series = _series;
        final now = widget.clock.now();
        return Scaffold(
          appBar: AppBar(
            title: Text(loaded?.value.name ?? widget.deviceId),
          ),
          body: loaded == null
              ? Center(
                  child: snap.hasError
                      ? const Text('Не вдалося завантажити пристрій')
                      : const CircularProgressIndicator(),
                )
              : Column(
                  children: [
                    if (loaded.error != null)
                      OfflineBanner(savedAt: loaded.savedAt, now: now),
                    Expanded(
                      child: ListView(
                        padding: const EdgeInsets.all(8),
                        children: [
                          for (final l in loaded.value.latest)
                            MetricCard(latest: _fresher(l), now: now),
                          if (series != null) _Chart(series: series),
                          QueuePanel(
                            queue: widget.queue,
                            deviceId: widget.deviceId,
                          ),
                          const SizedBox(height: 8),
                          // Поки перший полив у черзі, кнопка вимкнена:
                          // другий дотик дав би другу команду з іншим ключем
                          StreamBuilder<QueueEvent>(
                            stream: widget.queue.events,
                            builder: (_, _) {
                              final busy = widget.queue.hasPending(
                                widget.deviceId,
                                'irrigate',
                              );
                              return FilledButton.icon(
                                icon: const Icon(Icons.water_drop_outlined),
                                label: Text(
                                  busy ? 'Полив у черзі' : 'Полити 30 с',
                                ),
                                onPressed: busy ? null : _irrigate,
                              );
                            },
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
        );
      },
    );
  }
}
