import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:greenhouse_mobile/core/api_client.dart';
import 'package:greenhouse_mobile/core/clock.dart';
import 'package:greenhouse_mobile/core/offline_queue.dart';
import 'package:greenhouse_mobile/core/store.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// Сервер-імітація з журналом: кожен запит записується, відповідь
/// задає сценарій. Ключ ідемпотентності працює так само, як на еталонному
/// сервері: повтор повертає ту саму команду.
class FakeServer {
  final log = <http.Request>[];
  final commands = <String, String>{}; // ключ → id команди
  final Map<String, Object?> settings = {'soil_moisture_min': 35};
  int version = 3;
  final List<Object> script = []; // 'drop' | 'drop-after' | код відповіді
  bool Function(http.Request)? poison; // запит, на який завжди 500
  Completer<void>? gate; // перший запит чекає на нього
  var n = 0;

  http.Response json(
    Object body,
    int status, [
    Map<String, String> h = const {},
  ]) => http.Response.bytes(
    utf8.encode(jsonEncode(body)),
    status,
    headers: {'content-type': 'application/json', ...h},
  );

  Future<http.Response> handle(http.Request r) async {
    log.add(r);
    final g = gate;
    gate = null;
    if (g != null) await g.future;
    if (poison?.call(r) ?? false) return json({'title': 'збій'}, 500);
    final step = script.isEmpty ? null : script.removeAt(0);
    if (step == 'drop') throw http.ClientException('до сервера не дійшло');
    final res = _apply(r, step);
    if (step == 'drop-after') {
      throw http.ClientException('відповідь загубилась');
    }
    return res;
  }

  http.Response _apply(http.Request r, Object? step) {
    if (step is int) return json({'title': 'збій', 'status': step}, step);
    if (r.method == 'POST') {
      final key = r.headers['Idempotency-Key']!;
      final id = commands.putIfAbsent(key, () => 'cmd-${++n}');
      final body = jsonDecode(r.body) as Map<String, dynamic>;
      return json({
        'id': id,
        'device_id': 'gh1',
        'name': body['name'],
        'status': 'pending',
      }, 202);
    }
    // PUT /settings з If-Match
    if (r.headers['If-Match'] != '"$version"') {
      return json({
        'type': 'https://greenhouse.example/problems/precondition-failed',
        'current': settings,
        'current_etag': '"$version"',
      }, 412);
    }
    settings
      ..clear()
      ..addAll((jsonDecode(r.body) as Map<String, dynamic>).cast());
    version++;
    return json(settings, 200, {'etag': '"$version"'});
  }
}

void main() {
  final t0 = DateTime.utc(2026, 11, 4, 12);
  late ManualClock clock;
  late FakeServer server;
  late MemoryStore store;
  late OfflineQueue queue;
  late List<QueueEvent> events;
  var ids = 0;

  OfflineQueue make() => OfflineQueue(
    store: store,
    api: ApiClient(
      base: Uri.parse('http://bed.test/api/v1/'),
      client: MockClient(server.handle),
      clock: ServerClock(clock),
    ),
    clock: clock,
    newId: () => 'key-${(++ids).toString().padLeft(8, '0')}',
    rnd: () => 0.5,
  );

  setUp(() async {
    clock = ManualClock(t0);
    server = FakeServer();
    store = MemoryStore();
    ids = 0;
    queue = make();
    events = [];
    queue.events.listen(events.add);
  });

  List<QueueEventType> types() => [for (final e in events) e.type];

  test(
    'успішна відправлення: дія записана на диск до відправлення',
    () async {
      final a = await queue.enqueueCommand('gh1', 'irrigate', {
        'duration_sec': 30,
      });
      expect(
        await store.keys('q/'),
        hasLength(1),
        reason: 'на диску до відповіді',
      );
      await queue.flush();
      expect(server.log, hasLength(1));
      expect(server.log.single.headers['Idempotency-Key'], a.id);
      expect(queue.actions, isEmpty);
      expect(await store.keys('q/'), isEmpty);
      expect(types(), [QueueEventType.enqueued, QueueEventType.sent]);
    },
  );

  test(
    'втрачена відповідь: повтор несе той самий ключ, дубліката немає',
    () async {
      server.script.add(
        'drop-after',
      ); // сервер виконав, відповідь не дійшла
      final a = await queue.enqueueCommand('gh1', 'irrigate', {
        'duration_sec': 30,
      });
      final wait = await queue.flush();
      expect(wait, isNotNull);
      expect(queue.actions.single.attempts, 1);
      clock.advance(wait!);
      expect(await queue.flush(), isNull);
      expect(server.log.map((r) => r.headers['Idempotency-Key']), [
        a.id,
        a.id,
      ]);
      expect(
        server.commands,
        hasLength(1),
        reason: 'на сервері одна команда',
      );
      expect(queue.actions, isEmpty);
    },
  );

  test('перезапуск: чергу відновлено, ключ той самий', () async {
    server.script.add('drop');
    final a = await queue.enqueueCommand('gh1', 'irrigate', {
      'duration_sec': 30,
    });
    await queue.flush();
    final reborn = make();
    await reborn.load();
    expect(reborn.actions.single.id, a.id);
    expect(reborn.actions.single.attempts, 1);
    await reborn.flush(force: true);
    expect(server.commands.keys, [a.id]);
    expect(reborn.actions, isEmpty);
  });

  test('тимчасова відмова зупиняє чергу, порядок зберігається', () async {
    server.script.addAll(['drop']);
    await queue.enqueueCommand('gh1', 'set_setpoint', {
      'metric': 'temperature',
      'value': 20,
    });
    await queue.enqueueCommand('gh1', 'set_setpoint', {
      'metric': 'temperature',
      'value': 25,
    });
    var wait = await queue.flush();
    expect(server.log, hasLength(1), reason: 'другу дію не чіпали');
    clock.advance(wait!);
    wait = await queue.flush();
    expect(wait, isNull);
    final values = server.log.map(
      (r) => jsonDecode(r.body)['params']['value'],
    );
    expect(values, [20, 20, 25]);
  });

  test(
    'дія, додана посеред проходу, не чекає наступного виклику',
    () async {
      final gate = Completer<void>();
      server.gate = gate; // перший запит чекає, поки тест його відпустить
      await queue.enqueueCommand('gh1', 'irrigate', {'duration_sec': 5});
      for (var i = 0; i < 100 && server.log.isEmpty; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 1));
      }
      expect(
        server.log,
        hasLength(1),
        reason: 'прохід іде, відповіді ще немає',
      );
      await queue.enqueueCommand('gh1', 'irrigate', {'duration_sec': 6});
      expect(server.log, hasLength(1), reason: 'другий прохід не стартує');
      gate.complete();
      await queue.flush(); // той самий прохід, що вже йшов
      expect(server.log, hasLength(2), reason: 'його підібрав _rerun');
      expect(queue.actions, isEmpty);
    },
  );

  test('Retry-After довший за власну затримку перемагає', () async {
    server.script.add(503);
    await queue.enqueueCommand('gh1', 'irrigate', {'duration_sec': 5});
    final wait = await queue.flush();
    // власна: attempt 1, стеля 1 с, rnd 0,5 → 500 мс
    expect(wait, const Duration(milliseconds: 500));
    expect(await queue.flush(), wait, reason: 'до строку нічого не шлемо');
    expect(server.log, hasLength(1));
  });

  test('остаточна відмова не блокує наступні дії', () async {
    server.script.add(422);
    final bad = await queue.enqueueCommand('gh1', 'irrigate', {
      'duration_sec': 5,
    });
    await queue.enqueueCommand('gh1', 'irrigate', {'duration_sec': 6});
    await queue.flush();
    expect(server.log, hasLength(2));
    expect(queue.actions.single.id, bad.id);
    expect(queue.actions.single.status, ActionStatus.rejected);
    expect(queue.actions.single.error, startsWith('422'));
    await queue.dismiss(bad.id);
    expect(queue.actions, isEmpty);
  });

  test('строк дії: прострочена дія не йде на сервер', () async {
    server.script.add('drop');
    await queue.enqueueCommand('gh1', 'irrigate', {'duration_sec': 5});
    await queue.flush();
    clock.advance(const Duration(minutes: 6)); // строк поливу — 5 хв
    await queue.flush(force: true);
    expect(server.log, hasLength(1));
    expect(queue.actions.single.status, ActionStatus.expired);
  });

  test('«отруйна» дія блокує чергу не довше за свій строк', () async {
    server.poison = (r) => jsonDecode(r.body)['name'] == 'irrigate';
    await queue.enqueueCommand('gh1', 'irrigate', {'duration_sec': 5});
    await queue.enqueueCommand('gh1', 'set_setpoint', {
      'metric': 'humidity',
      'value': 60,
    });
    for (var i = 0; i < 4; i++) {
      expect(
        await queue.flush(force: true),
        isNotNull,
        reason: 'черга стоїть',
      );
    }
    expect(server.commands, isEmpty);
    clock.advance(const Duration(minutes: 5)); // строк поливу — 5 хв
    await queue.flush(force: true);
    expect(queue.actions.map((a) => a.status), [ActionStatus.expired]);
    expect(server.commands, hasLength(1), reason: 'уставку відправлено');
  });

  test('401 ставить чергу на паузу, resume() продовжує', () async {
    server.script.add(401);
    await queue.enqueueCommand('gh1', 'irrigate', {'duration_sec': 5});
    await queue.flush();
    expect(queue.paused, isTrue);
    expect(types(), contains(QueueEventType.authRequired));
    await queue.flush();
    expect(server.log, hasLength(1), reason: 'на паузі нічого не шлемо');
    queue.resume();
    await queue.flush();
    expect(queue.paused, isFalse);
    expect(queue.actions, isEmpty);
  });

  group('налаштування й ETag', () {
    test(
      'колізія 412 зберігає серверну копію; «залишити моє» проходить',
      () async {
        server.version = 4; // хтось змінив після читання ETag "3"
        server.settings['soil_moisture_min'] = 30;
        final a = await queue.enqueueSettings('gh1', {
          'soil_moisture_min': 40,
        }, ifMatch: '"3"');
        await queue.flush();
        expect(a.status, ActionStatus.conflict);
        expect(a.serverCopy, {'soil_moisture_min': 30});
        expect(a.serverEtag, '"4"');
        await queue.resolveKeepMine(a.id);
        await queue.flush();
        expect(queue.actions, isEmpty);
        expect(server.settings, {'soil_moisture_min': 40});
        expect(server.version, 5);
      },
    );

    test(
      'втрачена відповідь на PUT: власний запис не вважається колізією',
      () async {
        server.script.add('drop-after');
        await queue.enqueueSettings('gh1', {
          'soil_moisture_min': 40,
        }, ifMatch: '"3"');
        final wait = await queue.flush();
        clock.advance(wait!);
        await queue.flush();
        // повтор із "3" отримав 412, але current == те, що ми писали
        expect(queue.actions, isEmpty);
        expect(types().where((t) => t == QueueEventType.conflict), isEmpty);
        expect(server.settings, {'soil_moisture_min': 40});
        expect(server.version, 4, reason: 'записано один раз');
      },
    );
  });

  test('пошкоджений запис на диску не ламає завантаження', () async {
    await store.write('q/0000000001', '{"id":"x"');
    final a = await queue.enqueueCommand('gh1', 'irrigate', {
      'duration_sec': 5,
    });
    await queue.flush();
    final reborn = make();
    await reborn.load();
    expect(await store.read('q/0000000001'), isNull);
    expect(reborn.actions, isEmpty);
    expect(a.id, isNotEmpty);
  });
}
