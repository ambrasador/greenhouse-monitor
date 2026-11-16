import 'dart:async';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'core/api_client.dart';
import 'core/auth_session.dart';
import 'core/cache.dart';
import 'core/clock.dart';
import 'core/domain.dart';
import 'core/live_series.dart';
import 'core/offline_queue.dart';
import 'core/push_router.dart';
import 'core/queue_driver.dart';
import 'core/repository.dart';
import 'core/sse_client.dart';
import 'platform/lifecycle.dart';
import 'platform/prefs_store.dart';
import 'platform/secure_token_store.dart';
import 'ui/device_detail_screen.dart';
import 'ui/device_list_screen.dart';
import 'ui/login_screen.dart';

/// Адреса API: `flutter run --dart-define=API_BASE=http://10.0.2.2:3000/api/v1/`
/// (10.0.2.2 — хост-машина з точки зору емулятора Android).
const apiBase = String.fromEnvironment(
  'API_BASE',
  defaultValue: 'http://10.0.2.2:3000/api/v1/',
);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final clock = ServerClock(const SystemClock());
  final store = PrefsStore();
  final http1 = http.Client();
  final base = Uri.parse(apiBase);
  // Токени лежать у Keychain/Keystore, решта даних — у звичайному сховищі
  final session = AuthSession(
    base: base,
    client: http1,
    store: SecureTokenStore(),
    clock: clock.local,
  );
  await session.restore();
  final api = ApiClient(
    base: base,
    client: http1,
    clock: clock,
    token: session.accessToken,
    renew: session.renew,
  );
  final queue = OfflineQueue(store: store, api: api, clock: clock);
  await queue.load();
  final driver = QueueDriver(queue)..start();
  ResumeObserver(driver.onResumed).attach();
  final repo = DeviceRepository(
    api: api,
    cache: JsonCache(store, clock),
    clock: clock,
  );
  runApp(
    GreenhouseApp(
      repo: repo,
      queue: queue,
      clock: clock,
      liveFor: liveSeriesFactory(client: http1, api: api, clock: clock),
      session: session,
    ),
  );
}

/// Ряд для екрана пристрою. Метрику бере з посилання зі сповіщення, а без неї
/// — [primaryMetric]; вікно графіка — зі словника домену, для метрики, якої
/// там немає, типове.
LiveSeries Function(String deviceId, String? metric) liveSeriesFactory({
  required http.Client client,
  required ApiClient api,
  required Clock clock,
}) {
  return (id, requested) {
    final metric = requested ?? primaryMetric;
    final sse = SseClient(
      client: client,
      url: api.base.resolve('devices/$id/stream?metrics=$metric'),
      token: api.token,
      renew: api.renew,
    );
    return LiveSeries(
      metric: metric,
      window:
          greenhouse[metric]?.window ??
          const Duration(seconds: defaultWindowSec),
      open: sse.events,
      history: (from, to, cursor) => api.telemetry(
        device: id,
        metric: metric,
        from: from,
        to: to,
        cursor: cursor,
      ),
      clock: clock,
    );
  };
}

class GreenhouseApp extends StatefulWidget {
  const GreenhouseApp({
    super.key,
    required this.repo,
    required this.queue,
    required this.clock,
    required this.liveFor,
    this.session,
  });

  final DeviceRepository repo;
  final OfflineQueue queue;
  final Clock clock;
  final LiveSeries Function(String deviceId, String? metric) liveFor;

  /// Без сеансу застосунок працює як у розділі 5 (стенд без автентифікації).
  final AuthSession? session;

  @override
  State<GreenhouseApp> createState() => _GreenhouseAppState();
}

class _GreenhouseAppState extends State<GreenhouseApp> {
  final _nav = GlobalKey<NavigatorState>();
  StreamSubscription<bool>? _changes;

  @override
  void initState() {
    super.initState();
    // Вхід і вихід міняють весь стек екранів: після виходу назад повернутися
    // не можна, після входу — відкривається список
    _changes = widget.session?.changes.listen(
      (signedIn) => _nav.currentState?.pushNamedAndRemoveUntil(
        signedIn ? '/' : '/login',
        (_) => false,
      ),
    );
  }

  @override
  void dispose() {
    unawaited(_changes?.cancel());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final session = widget.session;
    return MaterialApp(
      title: 'Greenhouse Monitor',
      navigatorKey: _nav,
      theme: ThemeData(colorSchemeSeed: Colors.green, useMaterial3: true),
      // маршрут `/devices/<id>` — той самий, що відкриває push (deep link)
      onGenerateRoute: (settings) {
        // без входу будь-який маршрут, і посилання зі сповіщення також, веде на вхід
        if (session != null && !session.signedIn) {
          return MaterialPageRoute<void>(
            settings: const RouteSettings(name: '/login'),
            builder: (_) => LoginScreen(session: session),
          );
        }
        final uri = Uri.parse(settings.name ?? '/');
        final device =
            uri.pathSegments.length == 2 &&
                uri.pathSegments.first == 'devices'
            ? uri.pathSegments[1]
            : null;
        // рядок маршруту, як і дані push, недовірений: чужий ідентифікатор
        // веде на список, чужа метрика відкидається
        if (device != null && isSafeId(device)) {
          final metric = uri.queryParameters['metric'];
          return MaterialPageRoute<void>(
            settings: settings,
            builder: (_) => DeviceDetailScreen(
              repo: widget.repo,
              queue: widget.queue,
              clock: widget.clock,
              deviceId: device,
              metric: metric != null && isSafeId(metric) ? metric : null,
              liveFor: widget.liveFor,
            ),
          );
        }
        return MaterialPageRoute<void>(
          settings: settings,
          builder: (context) => DeviceListScreen(
            repo: widget.repo,
            clock: widget.clock,
            onOpen: (d) =>
                Navigator.of(context).pushNamed('/devices/${d.id}'),
          ),
        );
      },
    );
  }
}
