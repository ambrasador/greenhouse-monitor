import 'dart:async';
import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:greenhouse_mobile/core/api_client.dart';
import 'package:greenhouse_mobile/core/clock.dart';
import 'package:greenhouse_mobile/core/offline_queue.dart';
import 'package:greenhouse_mobile/core/queue_driver.dart';
import 'package:greenhouse_mobile/core/store.dart';
import 'package:greenhouse_mobile/platform/lifecycle.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// Таймер, яким керує тест: він лише запам’ятовує, коли й що мав запустити.
class FakeTimer implements Timer {
  FakeTimer(this.after, this.run);

  final Duration after;
  final void Function() run;
  bool cancelled = false;
  bool fired = false;

  @override
  void cancel() => cancelled = true;

  @override
  bool get isActive => !cancelled && !fired;

  @override
  int get tick => fired ? 1 : 0;

  void fire() {
    fired = true;
    run();
  }
}

void main() {
  final t0 = DateTime.utc(2026, 11, 4, 12);
  late ManualClock clock;
  late MemoryStore store;
  late List<http.Request> log;
  late List<http.Response Function()> script; // відповіді по черзі
  late List<FakeTimer> timers;
  late OfflineQueue queue;
  late QueueDriver driver;

  http.Response accepted() => http.Response(
    jsonEncode({
      'id': 'c1',
      'device_id': 'gh1',
      'name': 'irrigate',
      'status': 'pending',
    }),
    202,
    headers: {'content-type': 'application/json'},
  );

  http.Response failure(int status, [Map<String, String> h = const {}]) =>
      http.Response(
        jsonEncode({'title': 'збій'}),
        status,
        headers: {'content-type': 'application/json', ...h},
      );

  Iterable<FakeTimer> active() => timers.where((t) => t.isActive);

  setUp(() {
    clock = ManualClock(t0);
    store = MemoryStore();
    log = [];
    script = [];
    timers = [];
    queue = OfflineQueue(
      store: store,
      api: ApiClient(
        base: Uri.parse('http://bed.test/api/v1/'),
        client: MockClient((r) async {
          log.add(r);
          return script.isEmpty ? accepted() : script.removeAt(0)();
        }),
        clock: ServerClock(clock),
      ),
      clock: clock,
      rnd: () => 0.5,
    );
    driver = QueueDriver(
      queue,
      timer: (after, run) {
        final t = FakeTimer(after, run);
        timers.add(t);
        return t;
      },
    )..start();
  });

  tearDown(() => driver.stop());

  test('після обриву черга сама повторює спробу через паузу', () async {
    script.add(() => failure(503));
    await queue.enqueueCommand('gh1', 'irrigate', {'duration_sec': 30});
    await queue.flush();
    // перша спроба: стеля 1 с, rnd = 0,5 → пауза 500 мс
    expect(active(), hasLength(1));
    expect(active().single.after, const Duration(milliseconds: 500));
    expect(log, hasLength(1));

    clock.advance(const Duration(milliseconds: 500));
    active().single.fire();
    await queue.flush(); // приєднується до проходу, який розпочав таймер

    expect(log, hasLength(2));
    expect(queue.actions, isEmpty);
    expect(active(), isEmpty, reason: 'черга порожня: таймер не потрібен');
  });

  test('повернення на екран знімає паузу, яку назвав сервер', () async {
    script.add(() => failure(429, {'retry-after': '30'}));
    await queue.enqueueCommand('gh1', 'irrigate', {'duration_sec': 30});
    await queue.flush();
    expect(active().single.after, const Duration(seconds: 30));

    driver.onResumed(); // без жодного зсуву годинника
    await queue.flush();

    expect(log, hasLength(2));
    expect(queue.actions, isEmpty);
    expect(active(), isEmpty);
  });

  test('строк дії будить чергу раніше за довгу паузу', () async {
    script.add(() => failure(503, {'retry-after': '600'}));
    await queue.enqueueCommand('gh1', 'irrigate', {'duration_sec': 30});
    await queue.flush();
    // пауза 600 с, але полив чинний лише 5 хв
    expect(active().single.after, const Duration(minutes: 5));

    clock.advance(const Duration(minutes: 5));
    active().single.fire();
    await queue.flush();

    expect(log, hasLength(1), reason: 'прострочену дію не відправляють');
    expect(queue.actions.single.status, ActionStatus.expired);
    expect(active(), isEmpty);
  });

  test(
    'дії з минулого сеансу йдуть при запуску; після stop() тиша',
    () async {
      final second = OfflineQueue(
        store: store,
        api: queue.api,
        clock: clock,
        rnd: () => 0.5,
      );
      script.add(() => failure(503));
      await queue.enqueueCommand('gh1', 'irrigate', {'duration_sec': 30});
      await queue.flush();
      driver.stop();
      expect(active(), isEmpty, reason: 'stop() скасовує таймер');

      await second.load(); // «перезапуск»: нова черга читає диск
      final restarted = QueueDriver(
        second,
        timer: (a, r) => FakeTimer(a, r),
      )..start();
      await second.flush();
      expect(log, hasLength(2));
      expect(second.actions, isEmpty);
      restarted.stop();
    },
  );

  testWidgets('ResumeObserver реагує лише на повернення на екран', (
    tester,
  ) async {
    var woke = 0;
    final observer = ResumeObserver(() => woke++)..attach();
    addTearDown(observer.detach);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    expect(woke, 0);
    tester.binding.handleAppLifecycleStateChanged(
      AppLifecycleState.resumed,
    );
    expect(woke, 1);
  });
}
