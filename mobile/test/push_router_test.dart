import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:greenhouse_mobile/core/api_client.dart';
import 'package:greenhouse_mobile/core/channels.dart';
import 'package:greenhouse_mobile/core/clock.dart';
import 'package:greenhouse_mobile/core/push_router.dart';
import 'package:greenhouse_mobile/core/models.dart';
import 'package:greenhouse_mobile/core/push_tokens.dart';
import 'package:greenhouse_mobile/core/store.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  final t0 = DateTime.utc(2026, 11, 4, 12);
  late ManualClock clock;
  late PushRouter router;

  PushMessage msg({String? id = 'm1', Map<String, String>? data}) =>
      PushMessage(
        id: id,
        body: 'Вологість ґрунту 28,0 %',
        data:
            data ??
            {
              'device': 'gh1',
              'metric': 'soil_moisture',
              'ts': t0.toIso8601String(),
            },
      );

  setUp(() {
    clock = ManualClock(t0);
    router = PushRouter(clock: clock);
  });

  group('PushRouter', () {
    test('на передньому плані — банер із текстом сповіщення', () {
      final a = router.onReceived(msg());
      expect(a, isA<ShowBanner>());
      expect((a as ShowBanner).text, 'Вологість ґрунту 28,0 %');
    });

    test('дубль за messageId і застаріле повідомлення відкидаються', () {
      expect(router.onReceived(msg()), isA<ShowBanner>());
      expect((router.onReceived(msg()) as Ignore).reason, 'дубль');
      clock.advance(const Duration(minutes: 16));
      final old = msg(id: 'm2');
      expect((router.onReceived(old) as Ignore).reason, 'застаріле');
    });

    test('дотик → маршрут із пристроєм і метрикою', () {
      final a = router.onOpened(msg()) as OpenDevice;
      expect(a.route, '/devices/gh1?metric=soil_moisture');
      expect(
        router.onOpened(msg()),
        isA<Ignore>(),
        reason: 'той самий дотик двічі',
      );
    });

    test('недовірені ідентифікатори не потрапляють у маршрут', () {
      for (final bad in [
        '../admin',
        'gh1/../../x',
        'a b',
        '',
        'x' * 33,
        'gh1?x=1',
      ]) {
        final a = router.onOpened(
          msg(id: 'id-$bad', data: {'device': bad}),
        );
        expect(a, isA<Ignore>(), reason: bad);
      }
      final a = router.onOpened(
        msg(id: 'z', data: {'device': 'gh1', 'metric': '../../x'}),
      ) as OpenDevice;
      expect(
        a.route,
        '/devices/gh1',
        reason: 'метрику відкинуто, пристрій лишився',
      );
    });

    test('пам’ять про ідентифікатори обмежена', () {
      final small = PushRouter(clock: clock, remember: 3);
      for (var i = 0; i < 10; i++) {
        small.onReceived(msg(id: 'm$i'));
      }
      expect(
        small.onReceived(msg(id: 'm0')),
        isA<ShowBanner>(),
        reason: 'вже забуто',
      );
      expect(small.onReceived(msg(id: 'm9')), isA<Ignore>());
    });
  });

  group('TokenRegistrar', () {
    late List<http.Request> calls;
    late TokenRegistrar reg;
    late MemoryStore store;
    var fail503 = false;

    setUp(() {
      calls = [];
      fail503 = false;
      store = MemoryStore();
      final api = ApiClient(
        base: Uri.parse('http://bed.test/api/v1/'),
        client: MockClient((r) async {
          calls.add(r);
          return http.Response('{}', fail503 ? 503 : 200);
        }),
        clock: ServerClock(clock),
      );
      reg = TokenRegistrar(
        api: api,
        store: store,
        clock: clock,
        platform: 'android',
      );
    });

    test('нова адреса реєструється, та сама — раз на тиждень', () async {
      await reg.ensure(const PushTarget.token('tok-1'));
      await reg.ensure(const PushTarget.token('tok-1'));
      expect(calls, hasLength(1));
      expect(jsonDecode(calls.single.body), {
        'token': 'tok-1',
        'platform': 'android',
      });
      clock.advance(const Duration(days: 8));
      await reg.ensure(const PushTarget.token('tok-1'));
      expect(calls, hasLength(2));
      await reg.ensure(const PushTarget.token('tok-2'));
      expect(calls, hasLength(3), reason: 'нова адреса — одразу');
    });

    test('FID іде в поле fid', () async {
      await reg.ensure(const PushTarget.fid('fid-1'));
      expect(jsonDecode(calls.single.body), {
        'fid': 'fid-1',
        'platform': 'android',
      });
    });

    test('невдала реєстрація повторюється через refreshIfDue', () async {
      fail503 = true;
      await expectLater(
        reg.ensure(const PushTarget.fid('fid-1')),
        throwsA(isA<ApiException>()),
      );
      expect(calls, hasLength(1));
      fail503 = false;
      await reg.refreshIfDue(); // запис без мітки часу = сервер не знає
      expect(calls, hasLength(2));
      await reg.refreshIfDue();
      expect(
        calls,
        hasLength(2),
        reason: 'свіжа реєстрація не повторюється',
      );
      clock.advance(const Duration(days: 8));
      await reg.refreshIfDue();
      expect(calls, hasLength(3), reason: 'застаріла — нагадуємо');
    });

    test('вихід з облікового запису видаляє адресу на сервері', () async {
      await reg.ensure(const PushTarget.token('tok/1 x'));
      await reg.forget();
      expect(calls.last.method, 'DELETE');
      expect(calls.last.url.path, endsWith('/push-tokens/tok%2F1%20x'));
      await reg.forget();
      expect(calls, hasLength(2), reason: 'повторний вихід нічого не шле');
    });
  });

  group('канали', () {
    test('порядок переваги й порожній список = офлайн', () {
      const all = Availability(cloud: true, local: true, ble: true);
      expect(choose(Operation.command, all), [
        Channel.local,
        Channel.cloud,
        Channel.ble,
      ]);
      expect(choose(Operation.history, all), [Channel.cloud]);
      expect(choose(Operation.liveView, const Availability(cloud: true)), [
        Channel.cloud,
      ]);
      expect(choose(Operation.provisioning, all), [Channel.ble]);
      expect(choose(Operation.command, const Availability()), isEmpty);
    });

    test(
      'збій каналу — наступний; остаточна відмова не переходить далі',
      () async {
        const both = Availability(cloud: true, local: true);
        final tried = <Channel>[];
        final r = await viaChannels<String>(Operation.command, both, {
          Channel.local: () async {
            tried.add(Channel.local);
            throw ApiException(status: 0);
          },
          Channel.cloud: () async {
            tried.add(Channel.cloud);
            return 'ok';
          },
        });
        expect(
          [r, tried],
          [
            'ok',
            [Channel.local, Channel.cloud],
          ],
        );

        await expectLater(
          viaChannels<String>(Operation.command, both, {
            Channel.local: () async => throw ApiException(status: 422),
            Channel.cloud: () async => 'не має виконатися',
          }),
          throwsA(
            isA<ApiException>().having((e) => e.status, 'status', 422),
          ),
        );
      },
    );
  });
}
