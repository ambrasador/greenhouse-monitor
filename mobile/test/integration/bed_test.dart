// Інтеграційні тести: клієнт Dart проти еталонного сервера розділів 2–4,
// який стенд запускає окремим процесом Node (serve-mobile-bed.js).
//
//   BED_DIR=.. flutter test test/integration
//
// Без BED_DIR тести пропускаються: звичайному `flutter test` не потрібні
// ні Node, ні сервер. Імітація FCM перевіряє контракт HTTP v1, а не доставку
// на телефон: успіх тут означає «повідомлення правильно складене».
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:greenhouse_mobile/core/api_client.dart';
import 'package:greenhouse_mobile/core/clock.dart';
import 'package:greenhouse_mobile/core/live_series.dart';
import 'package:greenhouse_mobile/core/models.dart';
import 'package:greenhouse_mobile/core/offline_queue.dart';
import 'package:greenhouse_mobile/core/provisioning.dart';
import 'package:greenhouse_mobile/core/push_tokens.dart';
import 'package:greenhouse_mobile/core/sse_client.dart';
import 'package:greenhouse_mobile/core/store.dart';
import 'package:http/http.dart' as http;

import 'bed.dart';

class ClaimViaApi implements ClaimApi {
  ClaimViaApi(this.api);

  final ApiClient api;

  @override
  Future<void> claim(String deviceId) => api.claimDevice(deviceId);
}

/// «Контролер» пристрою за BLE: на кожне опитування відповідає зі сценарію.
class ScriptedTransport implements ProvisioningTransport {
  ScriptedTransport(this.states);

  final List<WifiState> states;
  var _i = 0;

  @override
  Future<void> connect() async {}

  @override
  Future<void> openSecureSession(String pop) async {}

  @override
  Future<void> sendCredentials(String ssid, String password) async {}

  @override
  Future<WifiState> readWifiState() async =>
      states[_i < states.length ? _i++ : states.length - 1];

  @override
  Future<void> disconnect() async {}
}

void main() {
  final dir = Platform.environment['BED_DIR'];
  final skip = dir == null
      ? 'задайте BED_DIR — теку зі serve-mobile-bed.js'
      : null;
  late Bed bed;

  setUpAll(() async {
    if (dir == null) return;
    HttpOverrides.global =
        null; // flutter_test за замовчуванням глушить HTTP
    bed = await Bed.start(dir);
  });
  tearDownAll(() async {
    if (dir != null) await bed.stop();
  });

  group('еталонний сервер', skip: skip, () {
    test('список пристроїв, останні значення, історія за вікно', () async {
      final api = clientFor(bed.api);
      final list = await api.listDevices();
      expect(
        list.items.map((d) => d.id),
        containsAll(['gh1-s01', 'gh1-s02']),
      );
      final d = await api.getDevice('gh1-s01');
      expect(
        d.latest.map((l) => l.metric),
        containsAll(['soil_moisture', 'temperature']),
      );
      final now = api.clock.now();
      final page = await api.telemetry(
        device: 'gh1-s01',
        metric: 'soil_moisture',
        from: now.subtract(const Duration(hours: 1)),
        to: now,
      );
      expect(page.points.length, greaterThan(50));
      expect(page.points.first.t, lessThan(page.points.last.t));
    });

    test(
      'годинник сервера: на одній машині зсув менший за секунду',
      () async {
        final api = clientFor(bed.api);
        await api.getDevice('gh1-s01');
        expect(
          api.clock.offset.abs(),
          lessThan(const Duration(seconds: 1)),
        );
      },
    );

    test(
      'команда з тим самим ключем створює один рядок; інше тіло — 422',
      () async {
        final api = clientFor(bed.api);
        const key = 'it-key-0001-aaaa';
        final before = (await bed.stats())['commands'] as int;
        final a = await api.sendCommand('gh1-s01', 'irrigate', {
          'duration_sec': 5,
        }, idempotencyKey: key);
        final b = await api.sendCommand('gh1-s01', 'irrigate', {
          'duration_sec': 5,
        }, idempotencyKey: key);
        expect(b.id, a.id);
        expect((await bed.stats())['commands'], before + 1);
        await expectLater(
          api.sendCommand('gh1-s01', 'irrigate', {
            'duration_sec': 9,
          }, idempotencyKey: key),
          throwsA(
            isA<ApiException>()
                .having((e) => e.status, 'status', 422)
                .having((e) => e.code, 'code', 'idempotency-key-reuse'),
          ),
        );
      },
    );

    test(
      'налаштування: застарілий ETag дає 412 зі свіжою копією',
      () async {
        final api = clientFor(bed.api);
        final s0 = await api.getSettings('gh1-s02');
        final s1 = await api.putSettings('gh1-s02', {
          'soil_moisture_min': 33,
        }, ifMatch: s0.etag);
        expect(s1.etag, isNot(s0.etag));
        await expectLater(
          api.putSettings('gh1-s02', {
            'soil_moisture_min': 36,
          }, ifMatch: s0.etag),
          throwsA(
            isA<ApiException>()
                .having((e) => e.kind, 'kind', FailureKind.conflict)
                .having(
                  (e) => e.extra['current_etag'],
                  'current_etag',
                  s1.etag,
                )
                .having(
                  (e) =>
                      (e.extra['current']
                          as Map<String, dynamic>)['soil_moisture_min'],
                  'current',
                  33,
                ),
          ),
        );
      },
    );

    test('SSE: живі точки; після обриву сервер повторює пропущене з ts включно', () async {
      final sse = SseClient(
        client: http.Client(),
        url: bed.api.resolve('devices/gh1-s02/stream?metrics=temperature'),
        sleep: (_) async {},
      );
      var (sub, first) = await open(sse);
      final t1 = DateTime.now().toUtc();
      await bed.reading('gh1-s02', 'temperature', 24.0, t1);
      await eventually(
        () async => first.any((e) => e.event == 'telemetry') ? true : null,
      );
      expect(sse.lastEventId, iso(t1));
      final cancelled = Stopwatch()..start();
      await sub.cancel(); // «обрив»
      expect(
        cancelled.elapsed,
        lessThan(const Duration(seconds: 2)),
        reason: 'скасування не повинно чекати наступної події сервера',
      );

      await bed.reading(
        'gh1-s02',
        'temperature',
        24.5,
        t1.add(const Duration(seconds: 1)),
      );
      await bed.reading(
        'gh1-s02',
        'temperature',
        25.0,
        t1.add(const Duration(seconds: 2)),
      );

      (sub, first) = await open(sse);
      await sub.cancel();
      final values = [
        for (final e in first.where((e) => e.event == 'telemetry'))
          ((jsonDecode(e.data) as Map<String, dynamic>)['value'] as num)
              .toDouble(),
      ];
      expect(values, [
        24.0,
        24.5,
        25.0,
      ], reason: 'перша точка — дубль, її зливає mergeSorted');
    });

    test(
      'ряд на справжньому сервері: пауза, точки за паузу, без дублів',
      () async {
        final api = clientFor(bed.api);
        final sse = SseClient(
          client: http.Client(),
          url: bed.api.resolve(
            'devices/gh1-s02/stream?metrics=soil_moisture',
          ),
          sleep: (_) async {},
        );
        final series = LiveSeries(
          metric: 'soil_moisture',
          open: sse.events,
          history: (from, to, cursor) => api.telemetry(
            device: 'gh1-s02',
            metric: 'soil_moisture',
            from: from,
            to: to,
            cursor: cursor,
          ),
          clock: api.clock,
        )..start();
        await eventually(
          () async => series.points.length > 50 ? true : null,
        );
        final before = series.points.length;

        final t1 = DateTime.now().toUtc();
        await bed.reading('gh1-s02', 'soil_moisture', 50.0, t1);
        await eventually(
          () async => series.points.last.v == 50.0 ? true : null,
        );
        await series.stop();

        // поки потік закрито, пристрій надіслав ще дві точки
        await bed.reading(
          'gh1-s02',
          'soil_moisture',
          51.0,
          t1.add(const Duration(seconds: 1)),
        );
        await bed.reading(
          'gh1-s02',
          'soil_moisture',
          52.0,
          t1.add(const Duration(seconds: 2)),
        );
        series.start();
        await eventually(
          () async => series.points.last.v == 52.0 ? true : null,
        );
        await series.stop();

        final ts = [for (final p in series.points) p.t];
        expect(ts.toSet(), hasLength(ts.length), reason: 'без дублів');
        expect(ts, orderedEquals([...ts]..sort()));
        expect(series.points, hasLength(before + 3));
        expect(
          series.points.reversed.take(3).map((p) => p.v).toList().reversed,
          [50.0, 51.0, 52.0],
        );
      },
    );

    test('прив’язка: 409 device-offline, пристрій виходить на зв’язок, далі 201', () async {
      final ann = clientFor(bed.api, headers: {'X-User': 'ann'});
      var sleeps = 0;
      Provisioner provisioner(ApiClient api) => Provisioner(
        transport: ScriptedTransport([
          WifiState.connecting,
          WifiState.connected,
        ]),
        api: ClaimViaApi(api),
        clock: const SystemClock(),
        delay: (_) async {
          sleeps++;
          if (sleeps == 3) {
            await bed.reading(
              'gh1-new',
              'temperature',
              21.5,
              DateTime.now(),
            );
          }
        },
      );
      final r = await provisioner(ann).run(
        deviceId: 'gh1-new',
        pop: 'abcd1234',
        ssid: 'farm',
        password: 'secret-pass',
      );
      expect(r.ok, isTrue, reason: '${r.failure}');
      expect(
        sleeps,
        3,
        reason: 'опитування Wi-Fi + два 409 до появи пристрою',
      );

      // повторна прив’язка тим самим користувачем безпечна, чужою — ні
      await ann.claimDevice('gh1-new');
      final bob = clientFor(bed.api, headers: {'X-User': 'bob'});
      final r2 = await provisioner(bob).run(
        deviceId: 'gh1-new',
        pop: 'abcd1234',
        ssid: 'farm',
        password: 'secret-pass',
      );
      expect(r2.failure, Failure.alreadyClaimed);
    });

    test(
      'токен → тривога → push: поля повідомлення й вихід з акаунта',
      () async {
        final api = clientFor(bed.api, headers: {'X-User': 'ann'});
        const fid = 'fid_ann_android_0123456789abcdef';
        await bed.post('/fcm/valid-token', {'token': fid});
        await bed.post('/owner', {'device': 'gh1-s01', 'user': 'ann'});
        final registrar = TokenRegistrar(
          api: api,
          store: MemoryStore(),
          clock: const SystemClock(),
          platform: 'android',
        );
        await registrar.ensure(const PushTarget.fid(fid));

        await bed.reading('gh1-s01', 'soil_moisture', 28.4, DateTime.now());
        final msg = await eventually<Map<String, dynamic>>(() async {
          final d = (await bed.stats())['delivered'] as List<dynamic>;
          return d.isEmpty ? null : d.first as Map<String, dynamic>;
        });
        expect(msg['fid'], fid);
        expect(msg.containsKey('token'), isFalse);
        final data = msg['data'] as Map<String, dynamic>;
        expect(data['device'], 'gh1-s01');
        expect(data.values, everyElement(isA<String>()));
        final android = msg['android'] as Map<String, dynamic>;
        expect(android.containsKey('collapse_key'), isFalse);
        expect(
          (android['notification'] as Map<String, dynamic>)['tag'],
          'gh1-s01:soil_moisture',
        );
        expect((await bed.stats())['rejected'], isEmpty);

        await registrar.forget();
        expect((await bed.stats())['tokens'], isEmpty);
      },
    );

    test(
      'черга + проксі, що губить відповіді: рівно N рядків на сервері',
      () async {
        await bed.post('/fault', {
          'lossAfter': 0.4,
          'lossBefore': 0.1,
          'seed': 7,
        });
        addTearDown(
          () => bed.post('/fault', {'lossAfter': 0, 'lossBefore': 0}),
        );
        final queue = OfflineQueue(
          store: MemoryStore(),
          api: clientFor(bed.lossy),
          clock: const SystemClock(),
          rnd: () => 0,
        );
        const n = 30;
        final before = (await bed.stats())['commands'] as int;
        for (var i = 0; i < n; i++) {
          await queue.enqueueCommand('gh1-s01', 'irrigate', {
            'duration_sec': 5,
          });
          for (var k = 0; k < 40 && queue.pendingCount > 0; k++) {
            await queue.flush(force: true);
          }
        }
        expect(queue.pendingCount, 0);
        final stats = await bed.stats();
        expect((stats['commands'] as int) - before, n);
        final proxy = stats['proxy'] as Map<String, dynamic>;
        expect(
          proxy['droppedAfter'],
          greaterThan(0),
          reason: 'відповіді справді губились',
        );
      },
    );
  });

  group('межа повторення SSE', skip: skip, () {
    test(
      'пропуск більший за replayLimit дає reset замість повтору',
      () async {
        final small = await Bed.start(dir!, {
          'sse': {'replayLimit': 3},
        });
        addTearDown(small.stop);
        final sse = SseClient(
          client: http.Client(),
          url: small.api.resolve(
            'devices/gh1-s01/stream?metrics=temperature',
          ),
          sleep: (_) async {},
        );
        var (sub, first) = await open(sse);
        final t1 = DateTime.now().toUtc();
        await small.reading('gh1-s01', 'temperature', 20, t1);
        await eventually(
          () async =>
              first.any((e) => e.event == 'telemetry') ? true : null,
        );
        await sub.cancel();
        for (var i = 1; i <= 5; i++) {
          await small.reading(
            'gh1-s01',
            'temperature',
            20.0 + i,
            t1.add(Duration(seconds: i)),
          );
        }
        (sub, first) = await open(sse);
        await sub.cancel();
        final names = first.map((e) => e.event).toList();
        expect(names, ['reset', 'ready']);
      },
    );
  });
}
