import 'dart:async';
import 'dart:convert';
import 'dart:io' show HttpDate;

import 'package:flutter_test/flutter_test.dart';
import 'package:greenhouse_mobile/core/api_client.dart';
import 'package:greenhouse_mobile/core/clock.dart';
import 'package:greenhouse_mobile/core/merge.dart';
import 'package:greenhouse_mobile/core/models.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response reply(
  Object? body,
  int status, [
  Map<String, String> h = const {},
]) => http.Response.bytes(
  utf8.encode(jsonEncode(body)),
  status,
  headers: {'content-type': 'application/json; charset=utf-8', ...h},
);

void main() {
  final t0 = DateTime.utc(2026, 11, 4, 12);
  late ServerClock clock;
  late http.Request seen;

  ApiClient api(
    Future<http.Response> Function(http.Request) handler, {
    TokenProvider? token,
    Duration? timeout,
  }) {
    return ApiClient(
      base: Uri.parse('http://bed.test/api/v1/'),
      client: MockClient((r) {
        seen = r;
        return handler(r);
      }),
      clock: clock,
      token: token,
      timeout: timeout ?? const Duration(seconds: 10),
    );
  }

  setUp(() => clock = ServerClock(ManualClock(t0)));

  test('listDevices: розбір, курсор, токен у заголовку', () async {
    final a = api(
      (_) async => reply({
        'data': [
          {
            'id': 'gh1',
            'name': 'Грядка А',
            'zone': 'north',
            'created_at': '2026-01-01T00:00:00.000Z',
            'last_seen': '2026-11-04T11:59:30.000Z',
          },
          {
            'id': 'gh2',
            'name': 'Грядка Б',
            'zone': 'south',
            'created_at': '2026-01-01T00:00:00.000Z',
            'last_seen': null,
          },
        ],
        'next': 'abc',
      }, 200),
      token: () async => 'tok',
    );
    final page = await a.listDevices(cursor: 'zzz', limit: 2);
    expect(page.items.map((d) => d.name), ['Грядка А', 'Грядка Б']);
    expect(page.items[1].lastSeen, isNull);
    expect(page.next, 'abc');
    expect(seen.url.queryParameters, {'limit': '2', 'cursor': 'zzz'});
    expect(seen.headers['Authorization'], 'Bearer tok');
  });

  test('sendCommand: тіло, Idempotency-Key, 202 → запис команди', () async {
    final a = api(
      (_) async => reply({
        'id': 'c1',
        'device_id': 'gh1',
        'name': 'irrigate',
        'params': {'duration_sec': 30},
        'status': 'pending',
      }, 202),
    );
    final c = await a.sendCommand('gh1', 'irrigate', {
      'duration_sec': 30,
    }, idempotencyKey: 'key-0001-abcd');
    expect(c.status, CommandStatus.pending);
    expect(seen.method, 'POST');
    expect(seen.url.path, '/api/v1/devices/gh1/commands');
    expect(seen.headers['Idempotency-Key'], 'key-0001-abcd');
    expect(jsonDecode(seen.body), {
      'name': 'irrigate',
      'params': {'duration_sec': 30},
    });
  });

  group('класифікація відмов', () {
    Future<ApiException> fail(Future<http.Response> Function() h) async {
      final a = api((_) => h());
      try {
        await a.getDevice('x');
      } on ApiException catch (e) {
        return e;
      }
      fail_('очікувалась ApiException');
    }

    test('404 problem+json: код з type, повтор не допоможе', () async {
      final e = await fail(
        () async => reply({
          'type': 'https://greenhouse.example/problems/device-not-found',
          'title': 'Пристрій не знайдено',
          'status': 404,
        }, 404),
      );
      expect(
        [e.status, e.code, e.kind],
        [404, 'device-not-found', FailureKind.rejected],
      );
      expect(e.title, 'Пристрій не знайдено');
    });

    test('503 з Retry-After у секундах', () async {
      final e = await fail(
        () async => reply({'title': 'x'}, 503, {'retry-after': '7'}),
      );
      expect(
        [e.kind, e.retryAfter],
        [FailureKind.transient, const Duration(seconds: 7)],
      );
    });

    test('429 з Retry-After у форматі HTTP-date', () async {
      final at = HttpDate.format(t0.add(const Duration(seconds: 90)));
      final e = await fail(() async => reply({}, 429, {'retry-after': at}));
      expect(e.kind, FailureKind.transient);
      expect(e.retryAfter, const Duration(seconds: 90));
    });

    test('401 → auth; 412 → conflict із current_etag', () async {
      expect(
        (await fail(() async => reply({}, 401))).kind,
        FailureKind.auth,
      );
      final e = await fail(
        () async => reply({
          'type': 'https://greenhouse.example/problems/precondition-failed',
          'current': {'soil_moisture_min': 40},
          'current_etag': '"7"',
        }, 412),
      );
      expect(e.kind, FailureKind.conflict);
      expect(e.extra['current_etag'], '"7"');
    });

    test('502 від проксі не є JSON: transient, коду немає', () async {
      final e = await fail(
        () async => http.Response('<html>Bad Gateway</html>', 502),
      );
      expect([e.kind, e.code], [FailureKind.transient, isNull]);
    });

    test('обрив зв’язку і тайм-аут: status 0, transient', () async {
      final cut = await fail(
        () async => throw http.ClientException('reset'),
      );
      expect([cut.status, cut.kind], [0, FailureKind.transient]);

      final hang = api(
        (_) => Completer<http.Response>().future,
        timeout: const Duration(milliseconds: 30),
      );
      await expectLater(
        hang.getDevice('x'),
        throwsA(
          isA<ApiException>()
              .having((e) => e.status, 'status', 0)
              .having((e) => e.title, 'title', 'тайм-аут'),
        ),
      );
    });
  });

  test('заголовок Date зсуває годинник сервера', () async {
    final a = api(
      (_) async => reply(
        {'id': 'gh1', 'name': 'A', 'zone': 'n', 'latest': <Object>[]},
        200,
        {'date': HttpDate.format(t0.add(const Duration(minutes: 7)))},
      ),
    );
    await a.getDevice('gh1');
    expect(clock.offset.inSeconds, inInclusiveRange(7 * 60, 7 * 60 + 1));
  });

  test('налаштування: ETag зі сховища, If-Match при записі', () async {
    final a = api(
      (r) async => r.method == 'GET'
          ? reply({'soil_moisture_min': 35}, 200, {'etag': '"3"'})
          : reply({'soil_moisture_min': 40}, 200, {'etag': '"4"'}),
    );
    final s = await a.getSettings('gh1');
    expect(s.etag, '"3"');
    final saved = await a.putSettings('gh1', {
      'soil_moisture_min': 40,
    }, ifMatch: s.etag);
    expect(saved.etag, '"4"');
    expect(seen.headers['If-Match'], '"3"');
  });

  test('telemetry: точки у мілісекундах і курсор', () async {
    final a = api(
      (_) async => reply({
        'data': [
          {'ts': '2026-11-04T11:00:00.000Z', 'value': 41.5},
          {'ts': '2026-11-04T11:01:00.000Z', 'value': 41},
        ],
        'next': 'n2',
      }, 200),
    );
    final p = await a.telemetry(
      device: 'gh1',
      metric: 'soil_moisture',
      from: t0.subtract(const Duration(hours: 1)),
      to: t0,
    );
    expect(p.points, [
      Point(DateTime.utc(2026, 11, 4, 11).millisecondsSinceEpoch, 41.5),
      Point(DateTime.utc(2026, 11, 4, 11, 1).millisecondsSinceEpoch, 41),
    ]);
    expect(p.next, 'n2');
    expect(seen.url.queryParameters['from'], '2026-11-04T11:00:00.000Z');
  });

  test(
    'telemetry: мікросекунди з годинника не потрапляють у запит',
    () async {
      // сервер приймає не більше трьох знаків після коми
      final a = api(
        (_) async => reply({'data': <Object?>[], 'next': null}, 200),
      );
      await a.telemetry(
        device: 'gh1',
        metric: 'soil_moisture',
        from: DateTime.utc(2026, 11, 4, 11, 0, 0, 123, 456),
        to: DateTime.utc(2026, 11, 4, 12, 0, 0, 999, 999),
      );
      expect(seen.url.queryParameters['from'], '2026-11-04T11:00:00.123Z');
      expect(seen.url.queryParameters['to'], '2026-11-04T12:00:00.999Z');
    },
  );
}

Never fail_(String m) => throw TestFailure(m);
