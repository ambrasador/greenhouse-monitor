import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:greenhouse_mobile/core/api_client.dart';
import 'package:greenhouse_mobile/core/cache.dart';
import 'package:greenhouse_mobile/core/clock.dart';
import 'package:greenhouse_mobile/core/domain.dart';
import 'package:greenhouse_mobile/core/live_series.dart';
import 'package:greenhouse_mobile/core/merge.dart';
import 'package:greenhouse_mobile/core/models.dart';
import 'package:greenhouse_mobile/core/offline_queue.dart';
import 'package:greenhouse_mobile/core/repository.dart';
import 'package:greenhouse_mobile/core/sse_client.dart';
import 'package:greenhouse_mobile/core/store.dart';
import 'package:greenhouse_mobile/main.dart';
import 'package:greenhouse_mobile/ui/device_detail_screen.dart';
import 'package:greenhouse_mobile/ui/device_list_screen.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'fonts/load_roboto.dart';

void main() {
  final t0 = DateTime.utc(2026, 11, 4, 12);
  late ManualClock local;
  late ServerClock clock;
  late MemoryStore store;
  var online = true;
  var posts = <http.Request>[];
  var puts = <http.Request>[];

  String iso(int secAgo) =>
      t0.subtract(Duration(seconds: secAgo)).toIso8601String();

  http.Response json(Object body, [int status = 200]) =>
      http.Response.bytes(
        utf8.encode(jsonEncode(body)),
        status,
        headers: {'content-type': 'application/json'},
      );

  Future<http.Response> server(http.Request r) async {
    if (!online) throw http.ClientException('немає мережі');
    if (r.method == 'PUT') {
      puts.add(r);
      return http.Response.bytes(
        utf8.encode(jsonEncode({'soil_moisture_min': 35})),
        200,
        headers: {'content-type': 'application/json', 'etag': '"3"'},
      );
    }
    if (r.method == 'POST') {
      posts.add(r);
      return json({
        'id': 'c1',
        'device_id': 'gh1',
        'name': 'irrigate',
        'status': 'pending',
      }, 202);
    }
    if (r.url.path.endsWith('/devices')) {
      return json({
        'data': [
          {
            'id': 'gh1',
            'name': 'Грядка А',
            'zone': 'north',
            'created_at': iso(9999),
            'last_seen': iso(20),
          },
          {
            'id': 'gh4',
            'name': 'Грядка Г',
            'zone': 'south',
            'created_at': iso(9999),
            'last_seen': iso(360),
          },
        ],
        'next': null,
      });
    }
    return json({
      'id': 'gh1',
      'name': 'Грядка А',
      'zone': 'north',
      'created_at': iso(9999),
      'latest': [
        {
          'metric': 'soil_moisture',
          'ts': iso(20),
          'value': 28.0,
          'unit': '%',
        },
        {
          'metric': 'temperature',
          'ts': iso(600),
          'value': 31.0,
          'unit': '°C',
        },
      ],
    });
  }

  ApiClient api() => ApiClient(
    base: Uri.parse('http://bed.test/api/v1/'),
    client: MockClient(server),
    clock: clock,
  );

  DeviceRepository repo() => DeviceRepository(
    api: api(),
    cache: JsonCache(store, clock),
    clock: clock,
  );

  setUp(() {
    local = ManualClock(t0);
    clock = ServerClock(local);
    store = MemoryStore();
    online = true;
    posts = [];
    puts = [];
  });

  Widget app(Widget home) => MaterialApp(home: home);

  testWidgets('список: статус складається зі значка й слова', (
    tester,
  ) async {
    await tester.pumpWidget(
      app(DeviceListScreen(repo: repo(), clock: clock, onOpen: (_) {})),
    );
    await tester.pumpAndSettle();
    expect(find.text('Грядка А'), findsOneWidget);
    expect(find.text('Норма'), findsOneWidget);
    expect(
      find.text('Немає даних'),
      findsOneWidget,
      reason: 'Грядка Г мовчить 6 хв > 3 періодів',
    );
    expect(find.byIcon(Icons.check_circle_outline), findsOneWidget);
    expect(find.byIcon(Icons.help_outline), findsOneWidget);
    expect(find.textContaining('Немає зв’язку'), findsNothing);
  });

  testWidgets('без мережі список береться з кешу з підписом про вік', (
    tester,
  ) async {
    // перший запуск з мережею наповнює кеш
    await tester.pumpWidget(
      app(DeviceListScreen(repo: repo(), clock: clock, onOpen: (_) {})),
    );
    await tester.pumpAndSettle();
    // другий — без мережі, через 3 хв
    online = false;
    local.advance(const Duration(minutes: 3));
    await tester.pumpWidget(
      app(
        DeviceListScreen(
          key: UniqueKey(),
          repo: repo(),
          clock: clock,
          onOpen: (_) {},
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Грядка А'), findsOneWidget);
    expect(find.textContaining('Дані станом на'), findsOneWidget);
    expect(find.textContaining('3 хв тому'), findsWidgets);
    // стара мітка last_seen більше не «свіжа»: застосунок не вдає, що знає стан
    expect(find.text('Немає даних'), findsNWidgets(2));
  });

  testWidgets(
    'список: без нових даних «Норма» через 3 періоди стає «Немає даних»',
    (tester) async {
      await tester.pumpWidget(
        app(DeviceListScreen(repo: repo(), clock: clock, onOpen: (_) {})),
      );
      await tester.pumpAndSettle();
      expect(find.text('Норма'), findsOneWidget);
      // нових даних немає, потік мовчить; змінюється лише годинник
      local.advance(const Duration(minutes: 5));
      await tester.pump(statusTick);
      expect(find.text('Норма'), findsNothing);
      expect(find.text('Немає даних'), findsNWidgets(2));
    },
  );

  testWidgets(
    'перемальовування не повторює запит, а потік у build() — повторює',
    (tester) async {
      var gets = 0;
      final repo = DeviceRepository(
        api: ApiClient(
          base: Uri.parse('http://bed.test/api/v1/'),
          client: MockClient((r) {
            gets++;
            return server(r);
          }),
          clock: clock,
        ),
        cache: JsonCache(store, clock),
        clock: clock,
      );
      final tick = ValueNotifier(0);
      Widget host(Widget child) => MaterialApp(
        home: ValueListenableBuilder<int>(
          valueListenable: tick,
          builder: (_, _, _) => child,
        ),
      );

      // потік у State створюється один раз
      await tester.pumpWidget(
        host(DeviceListScreen(repo: repo, clock: clock, onOpen: (_) {})),
      );
      await tester.pumpAndSettle();
      expect(gets, 1);
      tick.value++;
      await tester.pumpAndSettle();
      expect(
        gets,
        1,
        reason: 'перебудова батька не створила нового потоку',
      );

      // зламаний варіант: потік створюється в build()
      gets = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: ValueListenableBuilder<int>(
            valueListenable: tick,
            builder: (_, _, _) => StreamBuilder<Loaded<List<DeviceInfo>>>(
              stream: repo.watchDevices(),
              builder: (_, snap) => Text('${snap.data?.value.length ?? 0}'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(gets, 1);
      tick.value++;
      await tester.pumpAndSettle();
      expect(gets, 2, reason: 'кожна перебудова починає запит спочатку');
    },
  );

  testWidgets('без мережі й без кешу — повідомлення й «Повторити»', (
    tester,
  ) async {
    online = false;
    await tester.pumpWidget(
      app(DeviceListScreen(repo: repo(), clock: clock, onOpen: (_) {})),
    );
    await tester.pumpAndSettle();
    expect(find.text('Не вдалося завантажити пристрої'), findsOneWidget);
    online = true;
    await tester.tap(find.text('Повторити'));
    await tester.pumpAndSettle();
    expect(find.text('Грядка А'), findsOneWidget);
  });

  group('екран пристрою', () {
    OfflineQueue queue() => OfflineQueue(
      store: store,
      api: api(),
      clock: local,
      newId: () => 'key-00000001',
    );

    // кожне відкриття потоку дає новий контролер; тест бачить, що відкрито
    final feeds = <StreamController<SseEvent>>[];
    setUp(feeds.clear);

    LiveSeries Function(String, String?) seriesWith(Duration window) =>
        (id, metric) => LiveSeries(
          metric: metric ?? 'soil_moisture',
          window: window,
          open: () {
            final c = StreamController<SseEvent>();
            feeds.add(c);
            return c.stream;
          },
          history: (from, to, cursor) async =>
              TelemetryPage([Point(1, 1), Point(2, 3)], null),
          clock: local,
        );
    final seriesFor = seriesWith(const Duration(hours: 1));

    Widget screen(OfflineQueue q) => DeviceDetailScreen(
      repo: repo(),
      queue: q,
      clock: clock,
      deviceId: 'gh1',
      liveFor: seriesFor,
    );

    Widget detail(OfflineQueue q) => app(screen(q));

    testWidgets('рівні: критично за порогом, застаріле — «Немає даних»', (
      tester,
    ) async {
      await tester.pumpWidget(detail(queue()));
      await tester.pumpAndSettle();
      feeds.last.add(const SseEvent('ready', '{}', null)); // → історія
      await tester.pumpAndSettle();
      expect(
        find.text('Критично'),
        findsOneWidget,
        reason: 'вологість 28 < 30',
      );
      expect(
        find.text('Немає даних'),
        findsOneWidget,
        reason: 'температурі 10 хв',
      );
      expect(
        find.textContaining('Останнє значення: 31,0 °C'),
        findsOneWidget,
      );
      expect(
        find.bySemanticsLabel(
          RegExp('Графік «Вологість ґрунту», остання година'),
        ),
        findsOneWidget,
      );
    });

    testWidgets(
      'без нових даних «Критично» через 3 періоди стає «Немає даних»',
      (tester) async {
        await tester.pumpWidget(detail(queue()));
        await tester.pumpAndSettle();
        expect(find.text('Критично'), findsOneWidget);
        local.advance(const Duration(minutes: 5));
        await tester.pump(statusTick);
        expect(find.text('Критично'), findsNothing);
        expect(find.text('Немає даних'), findsNWidgets(2));
      },
    );

    testWidgets('жива точка оновлює картку своєї метрики, інші старіють', (
      tester,
    ) async {
      await tester.pumpWidget(detail(queue()));
      await tester.pumpAndSettle();
      feeds.last.add(const SseEvent('ready', '{}', null));
      feeds.last.add(
        SseEvent(
          'telemetry',
          '{"device":"gh1","metric":"soil_moisture",'
              '"ts":"${iso(5)}","value":41.0}',
          null,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('41,0 %'), findsOneWidget);
      expect(find.text('Критично'), findsNothing);
      expect(find.text('Норма'), findsOneWidget);
      expect(
        find.text('Немає даних'),
        findsOneWidget,
        reason: 'температура: точки від потоку немає, їй 10 хв',
      );
    });

    testWidgets('підпис графіка бере вікно з ряду, а не з екрана', (
      tester,
    ) async {
      await tester.pumpWidget(
        app(
          DeviceDetailScreen(
            repo: repo(),
            queue: queue(),
            clock: clock,
            deviceId: 'gh1',
            liveFor: seriesWith(const Duration(hours: 6)),
          ),
        ),
      );
      await tester.pumpAndSettle();
      feeds.last.add(const SseEvent('ready', '{}', null));
      await tester.pumpAndSettle();
      expect(find.text('Вологість ґрунту, останні 6 год'), findsOneWidget);
      expect(
        find.bySemanticsLabel(
          RegExp('Графік «Вологість ґрунту», останні 6 год'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('потік відкрито на екрані, закрито у фоні й після виходу', (
      tester,
    ) async {
      await tester.pumpWidget(detail(queue()));
      await tester.pumpAndSettle();
      expect(feeds, hasLength(1));
      expect(feeds.last.hasListener, isTrue);

      tester.binding.handleAppLifecycleStateChanged(
        AppLifecycleState.inactive,
      );
      await tester.pump();
      expect(
        feeds.last.hasListener,
        isTrue,
        reason: 'inactive — перехідний стан, екран міг одразу повернутись',
      );

      tester.binding.handleAppLifecycleStateChanged(
        AppLifecycleState.paused,
      );
      await tester.pump();
      expect(feeds.last.hasListener, isFalse);

      tester.binding.handleAppLifecycleStateChanged(
        AppLifecycleState.resumed,
      );
      await tester.pump();
      expect(feeds, hasLength(2));
      expect(feeds.last.hasListener, isTrue);

      await tester.pumpWidget(const SizedBox()); // екран закрито
      await tester.pump();
      expect(feeds.last.hasListener, isFalse);
    });

    testWidgets('без мережі полив іде в чергу і лишається видимим', (
      tester,
    ) async {
      final q = queue();
      await tester.pumpWidget(detail(q));
      await tester.pumpAndSettle();
      online = false;
      await tester.tap(find.text('Полити 30 с'));
      await tester.pumpAndSettle();
      expect(find.textContaining('поставлено в чергу'), findsOneWidget);
      expect(find.text('Полив 30 с'), findsOneWidget);
      expect(find.textContaining('Очікує відправлення'), findsOneWidget);
      expect(await store.keys('q/'), hasLength(1));

      // з’явилась мережа → «Надіслати зараз»
      online = true;
      await tester.tap(find.text('Надіслати зараз'));
      await tester.pumpAndSettle();
      expect(posts.single.headers['Idempotency-Key'], 'key-00000001');
      expect(find.text('Полив 30 с'), findsNothing);
    });

    testWidgets(
      'прострочена дія: без спроб — «не виконано», після спроб — «невідомо»',
      (tester) async {
        PendingAction act(String id, int attempts) => PendingAction(
          id: id,
          kind: ActionKind.command,
          deviceId: 'gh1',
          name: 'irrigate',
          params: {'duration_sec': 30},
          createdAt: t0,
          expiresAt: t0.add(const Duration(minutes: 5)),
          attempts: attempts,
        );
        // запис із попереднього сеансу: перша дія жодного разу не йшла на сервер
        await store.write(
          'q/0000000001',
          jsonEncode(act('a1', 0).toJson()),
        );
        await store.write(
          'q/0000000002',
          jsonEncode(act('a2', 3).toJson()),
        );
        final q = queue();
        await q.load();
        local.advance(const Duration(minutes: 6));
        await q.flush();

        await tester.pumpWidget(detail(q));
        await tester.pumpAndSettle();
        expect(
          posts,
          isEmpty,
          reason: 'прострочені дії на сервер не йдуть',
        );
        expect(find.textContaining('Дію не виконано'), findsOneWidget);
        expect(
          find.textContaining('Чи виконано дію — невідомо'),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'колізія: «Залишити моє» шле PUT з ETag сервера, «Взяти серверне» знімає дію',
      (tester) async {
        PendingAction conflict(String id) => PendingAction(
          id: id,
          kind: ActionKind.settings,
          deviceId: 'gh1',
          name: 'settings',
          params: {'soil_moisture_min': 35},
          createdAt: t0,
          expiresAt: t0.add(const Duration(hours: 24)),
          ifMatch: '"1"',
          status: ActionStatus.conflict,
          attempts: 1,
          serverCopy: {'soil_moisture_min': 40},
          serverEtag: '"2"',
        );
        await store.write(
          'q/0000000001',
          jsonEncode(conflict('k1').toJson()),
        );
        await store.write(
          'q/0000000002',
          jsonEncode(conflict('k2').toJson()),
        );
        final q = queue();
        await q.load();
        await tester.pumpWidget(detail(q));
        await tester.pumpAndSettle();
        expect(
          find.textContaining('Конфлікт: на сервері інші значення'),
          findsNWidgets(2),
        );
        expect(
          puts,
          isEmpty,
          reason: 'без рішення користувача запису немає',
        );

        await tester.tap(find.text('Взяти серверне').first);
        await tester.pumpAndSettle();
        expect(find.text('Взяти серверне'), findsOneWidget);
        expect(puts, isEmpty, reason: 'серверну копію не записують назад');

        await tester.tap(find.text('Залишити моє'));
        await tester.pumpAndSettle();
        expect(puts, hasLength(1));
        expect(
          puts.single.headers['If-Match'],
          '"2"',
          reason: 'повтор іде з ETag, який сервер щойно показав',
        );
        expect(jsonDecode(puts.single.body), {'soil_moisture_min': 35});
        expect(find.textContaining('Конфлікт'), findsNothing);
        expect(await store.keys('q/'), isEmpty);
      },
    );

    testWidgets('відхилена дія: причина словами, «Закрити» знімає запис', (
      tester,
    ) async {
      await store.write(
        'q/0000000001',
        jsonEncode(
          PendingAction(
            id: 'r1',
            kind: ActionKind.command,
            deviceId: 'gh1',
            name: 'irrigate',
            params: {'duration_sec': 30},
            createdAt: t0,
            expiresAt: t0.add(const Duration(minutes: 5)),
            status: ActionStatus.rejected,
            attempts: 1,
            error: '422 invalid-params',
          ).toJson(),
        ),
      );
      final q = queue();
      await q.load();
      await tester.pumpWidget(detail(q));
      await tester.pumpAndSettle();
      expect(
        find.text('Сервер відхилив: 422 invalid-params'),
        findsOneWidget,
      );
      expect(
        find.text('Полити 30 с'),
        findsOneWidget,
        reason: 'відхилена дія не блокує нового поливу',
      );

      await tester.tap(find.text('Закрити'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Сервер відхилив'), findsNothing);
      expect(await store.keys('q/'), isEmpty);
    });

    testWidgets('другий дотик не додає другий полив, доки перший у черзі', (
      tester,
    ) async {
      final q = queue();
      await tester.pumpWidget(detail(q));
      await tester.pumpAndSettle();
      online = false;
      await tester.tap(find.text('Полити 30 с'));
      await tester.pumpAndSettle();

      final button = find.bySubtype<FilledButton>();
      expect(find.text('Полив у черзі'), findsOneWidget);
      expect(tester.widget<FilledButton>(button).onPressed, isNull);
      await tester.tap(button, warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(
        await store.keys('q/'),
        hasLength(1),
        reason: 'друга дія не з’явилась',
      );

      online = true;
      await tester.tap(find.text('Надіслати зараз'));
      await tester.pumpAndSettle();
      expect(posts, hasLength(1));
      expect(find.text('Полити 30 с'), findsOneWidget);
      expect(tester.widget<FilledButton>(button).onPressed, isNotNull);
    });

    testWidgets(
      'маршрут зі сповіщення: ?metric= вибирає графік, чужі рядки не проходять',
      (tester) async {
        final asked = <(String, String?)>[];
        await tester.pumpWidget(
          GreenhouseApp(
            repo: repo(),
            queue: queue(),
            clock: clock,
            liveFor: (id, metric) {
              asked.add((id, metric));
              final window = greenhouse[metric ?? primaryMetric]!.window;
              return seriesWith(window)(id, metric);
            },
          ),
        );
        await tester.pumpAndSettle();
        final nav = tester.state<NavigatorState>(find.byType(Navigator));
        Future<void> open(String route) async {
          unawaited(nav.pushNamed<void>(route));
          await tester.pumpAndSettle();
        }

        await open('/devices/gh1?metric=temperature');
        expect(asked.last, ('gh1', 'temperature'));
        expect(
          find.text('Температура повітря, останні 6 год'),
          findsOneWidget,
        );
        nav.pop();
        await tester.pumpAndSettle();

        await open('/devices/gh1?metric=..%2F..%2Fx');
        expect(asked.last, (
          'gh1',
          null,
        ), reason: 'чужу метрику відкинуто, графік — за замовчуванням');
        expect(
          find.text('Вологість ґрунту, остання година'),
          findsOneWidget,
        );
        nav.pop();
        await tester.pumpAndSettle();

        asked.clear();
        await open('/devices/gh1%2F..%2Fx'); // не ідентифікатор
        expect(asked, isEmpty);
        expect(find.byType(DeviceDetailScreen), findsNothing);
      },
    );

    // один запис кожного стану, як після перезапуску: дії лежать у сховищі
    Future<OfflineQueue> queueWithAllStates() async {
      PendingAction act(String id, ActionStatus status, int attempts) {
        final settings = status == ActionStatus.conflict;
        return PendingAction(
          id: id,
          kind: settings ? ActionKind.settings : ActionKind.command,
          deviceId: 'gh1',
          name: settings ? 'settings' : 'irrigate',
          params: settings
              ? {'soil_moisture_min': 35}
              : {'duration_sec': 30},
          createdAt: t0,
          expiresAt: t0.add(const Duration(hours: 24)),
          ifMatch: settings ? '"1"' : null,
          status: status,
          attempts: attempts,
          serverCopy: settings ? {'soil_moisture_min': 40} : null,
          serverEtag: settings ? '"2"' : null,
          error: status == ActionStatus.rejected
              ? '422 invalid-params'
              : null,
        );
      }

      final all = [
        act('p', ActionStatus.pending, 2),
        act('c', ActionStatus.conflict, 1),
        act('e', ActionStatus.expired, 3),
        act('r', ActionStatus.rejected, 1),
      ];
      for (var i = 0; i < all.length; i++) {
        final key = 'q/${'$i'.padLeft(10, '0')}';
        await store.write(key, jsonEncode(all[i].toJson()));
      }
      final q = queue();
      await q.load();
      return q;
    }

    // Тест розкладки: розмір вікна, шрифт і масштаб тексту задано явно
    testWidgets(
      'на екрані 360 dp текст рядків черги не вужчий за 180 dp і при ×2',
      (tester) async {
        await loadRoboto(); // за замовчуванням тест малює шрифтом Ahem
        tester.view.physicalSize = const Size(1080, 1920); // 360 × 640 dp
        tester.view.devicePixelRatio = 3;
        addTearDown(tester.view.reset);
        addTearDown(tester.platformDispatcher.clearAllTestValues);
        final q = await queueWithAllStates();

        for (final scale in [1.0, 2.0]) {
          tester.platformDispatcher.textScaleFactorTestValue = scale;
          await tester.pumpWidget(
            MaterialApp(
              theme: ThemeData(fontFamily: 'Roboto'),
              home: screen(q),
            ),
          );
          await tester.pumpAndSettle();
          await tester.scrollUntilVisible(
            find.byType(QueuePanel),
            200,
            scrollable: find.byType(Scrollable).first,
          );
          for (final text in [
            'Очікує відправлення',
            'Конфлікт: на сервері інші значення',
            'Строк дії минув без відповіді',
            'Сервер відхилив',
          ]) {
            final width = tester.getSize(find.textContaining(text)).width;
            expect(
              width,
              greaterThan(180),
              reason: '«$text», шрифт ×$scale',
            );
          }
          expect(tester.takeException(), isNull);
        }
      },
    );
  });
}
