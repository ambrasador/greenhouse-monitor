import 'dart:async';
import 'dart:convert';
import 'dart:io' show SocketException;

import 'package:flutter_test/flutter_test.dart';
import 'package:greenhouse_mobile/core/api_client.dart';
import 'package:greenhouse_mobile/core/auth_session.dart';
import 'package:greenhouse_mobile/core/clock.dart';
import 'package:greenhouse_mobile/core/sse_client.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response json(Object? body, int status, [Map<String, String> h = const {}]) =>
    http.Response.bytes(
      utf8.encode(jsonEncode(body)),
      status,
      headers: {'content-type': 'application/json; charset=utf-8', ...h},
    );

http.Response problem(String kind, int status, [Map<String, String> h = const {}]) =>
    json({'type': 'https://greenhouse.example/problems/$kind', 'title': kind, 'status': status}, status, h);

Map<String, Object?> pair(int n, {int expiresIn = 900}) => {
  'token_type': 'Bearer',
  'access_token': 'access-$n',
  'refresh_token': 'refresh-token-number-$n',
  'expires_in': expiresIn,
};

/// Умовний сервер: приймає лише токени зі множини [valid].
class FakeAuthServer {
  final valid = <String>{};
  final log = <String>[];
  int issued = 0;
  int refreshes = 0;
  int refreshStatus = 200;
  Completer<void>? hold; // затримує відповідь на refresh
  bool offline = false;

  http.Response issue({int expiresIn = 900}) {
    issued++;
    valid.add('access-$issued');
    return json(pair(issued, expiresIn: expiresIn), 200);
  }

  Future<http.Response> handle(http.Request r) async {
    if (offline) throw const SocketException('offline');
    log.add('${r.method} ${r.url.path}');
    if (r.url.path.endsWith('/auth/login')) {
      final b = jsonDecode(r.body) as Map<String, dynamic>;
      if (b['password'] == 'secret-password') return issue();
      if (b['password'] == 'slow-down') {
        return problem('rate-limited', 429, {'retry-after': '37'});
      }
      return problem('invalid-credentials', 401);
    }
    if (r.url.path.endsWith('/auth/refresh')) {
      refreshes++;
      await hold?.future;
      if (refreshStatus == 200) return issue();
      return problem(refreshStatus == 401 ? 'invalid-grant' : 'internal', refreshStatus);
    }
    if (r.url.path.endsWith('/auth/logout')) return http.Response('', 204);
    final token = r.headers['Authorization']?.substring(7);
    if (!valid.contains(token)) return problem('token-expired', 401);
    return json({'data': <Object?>[], 'next': null}, 200);
  }
}

void main() {
  final base = Uri.parse('http://bed.test/api/v1/');
  final t0 = DateTime.utc(2026, 11, 5, 9);
  late ManualClock clock;
  late FakeAuthServer srv;
  late MemoryTokenStore store;
  late AuthSession session;

  AuthSession make({TokenStore? s, http.Client? client}) => AuthSession(
    base: base,
    client: client ?? MockClient(srv.handle),
    store: s ?? store,
    clock: clock,
  );

  setUp(() {
    clock = ManualClock(t0);
    srv = FakeAuthServer();
    store = MemoryTokenStore();
    session = make();
  });

  group('AuthSession', () {
    test('вхід зберігає пару, повідомляє змінюваність; хибний пароль і 429', () async {
      final events = <bool>[];
      session.changes.listen(events.add);
      await expectLater(
        session.signIn('agro', 'wrong'),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'invalid-credentials')),
      );
      await expectLater(
        session.signIn('agro', 'slow-down'),
        throwsA(isA<ApiException>().having((e) => e.retryAfter, 'retryAfter', const Duration(seconds: 37))),
      );
      expect(session.signedIn, isFalse);
      await session.signIn('agro', 'secret-password');
      await pumpEventQueue();
      expect(session.signedIn, isTrue);
      expect(events, [true]);
      expect(store.value!.access, 'access-1');
      expect(store.value!.expiresAt, t0.add(const Duration(seconds: 900)));
      expect(await session.accessToken(), 'access-1');
    });

    test('без входу токена немає: запит піде без заголовка', () async {
      expect(await session.accessToken(), isNull);
    });

    test('токен, що спливає за мить, оновлюється заздалегідь', () async {
      await session.signIn('agro', 'secret-password');
      clock.advance(const Duration(seconds: 880)); // лишилось 20 с < skew
      expect(await session.accessToken(), 'access-2');
      expect(srv.refreshes, 1);
      expect(store.value!.refresh, 'refresh-token-number-2');
      expect(store.saves, 2, reason: 'вхід і обмін');
    });

    test('п’ять паралельних запитів — один обмін', () async {
      await session.signIn('agro', 'secret-password');
      clock.advance(const Duration(seconds: 895));
      srv.hold = Completer<void>();
      final all = Future.wait([for (var i = 0; i < 5; i++) session.accessToken()]);
      await pumpEventQueue();
      srv.hold!.complete();
      expect(await all, everyElement('access-2'));
      expect(srv.refreshes, 1);
    });

    test('renew із застарілим токеном — без запиту: пару вже оновлено', () async {
      await session.signIn('agro', 'secret-password');
      await session.renew('access-1'); // обмін
      await session.renew('access-1'); // той, хто спізнився
      expect(srv.refreshes, 1);
      await session.renew(null); // примусово
      expect(srv.refreshes, 2);
    });

    test('invalid-grant: сеанс завершено, сховище порожнє, зміна повідомлена', () async {
      final events = <bool>[];
      session.changes.listen(events.add);
      await session.signIn('agro', 'secret-password');
      srv.refreshStatus = 401;
      await expectLater(session.renew(null), throwsA(isA<SessionExpired>()));
      await pumpEventQueue();
      expect(session.signedIn, isFalse);
      expect(store.value, isNull);
      expect(events, [true, false]);
      expect(await session.accessToken(), isNull);
      await expectLater(session.renew('access-1'), throwsA(isA<SessionExpired>()));
    });

    test('збій обміну (5xx, мережа) не розлогінює; чинний токен ще служить', () async {
      await session.signIn('agro', 'secret-password');
      clock.advance(const Duration(seconds: 880));
      srv.refreshStatus = 503;
      expect(await session.accessToken(), 'access-1', reason: 'ще 20 с життя');
      expect(session.signedIn, isTrue);
      clock.advance(const Duration(seconds: 30)); // токен спливе
      srv.offline = true;
      await expectLater(session.accessToken(), throwsA(isA<ApiException>().having((e) => e.status, 'status', 0)));
      expect(session.signedIn, isTrue);
      srv.offline = false;
      srv.refreshStatus = 200;
      expect(await session.accessToken(), 'access-2');
    });

    test('пара переживає перезапуск: restore() читає сховище', () async {
      await session.signIn('agro', 'secret-password');
      final reborn = make();
      expect(reborn.signedIn, isFalse);
      expect(await reborn.accessToken(), 'access-1');
      expect(reborn.signedIn, isTrue);
    });

    test('збій запису у сховище не губить нову пару', () async {
      final broken = _FailingStore(failAfter: 1);
      final s = make(s: broken);
      await s.signIn('agro', 'secret-password');
      clock.advance(const Duration(seconds: 890));
      expect(await s.accessToken(), 'access-2');
      expect(await s.accessToken(), 'access-2', reason: 'памʼять тримає нову пару');
    });

    test('вихід очищує локально навіть без мережі і шле refresh-токен', () async {
      await session.signIn('agro', 'secret-password');
      await session.signOut();
      expect(session.signedIn, isFalse);
      expect(store.value, isNull);
      expect(srv.log, contains('POST /api/v1/auth/logout'));
      await session.signIn('agro', 'secret-password');
      srv.offline = true;
      await session.signOut(); // не кидає
      expect(session.signedIn, isFalse);
    });
  });

  group('ApiClient з обміном токена', () {
    late ServerClock sclock;
    setUp(() => sclock = ServerClock(clock));

    ApiClient api(FakeAuthServer s, AuthSession a) => ApiClient(
      base: base,
      client: MockClient(s.handle),
      clock: sclock,
      token: a.accessToken,
      renew: a.renew,
    );

    test('401 «токен прострочено»: один обмін, один повтор з новим токеном', () async {
      await session.signIn('agro', 'secret-password');
      srv.valid.clear(); // сервер уже не визнає access-1
      final page = await api(srv, session).listDevices();
      expect(page.items, isEmpty);
      expect(srv.refreshes, 1);
      expect(srv.log.where((l) => l == 'GET /api/v1/devices').length, 2);
    });

    test('якщо обмін відхилено, помилка — auth (черга стане на паузу)', () async {
      await session.signIn('agro', 'secret-password');
      srv.valid.clear();
      srv.refreshStatus = 401;
      await expectLater(
        api(srv, session).listDevices(),
        throwsA(isA<SessionExpired>().having((e) => e.kind, 'kind', FailureKind.auth)),
      );
    });

    test('401 з іншої причини обміну не викликає', () async {
      await session.signIn('agro', 'secret-password');
      final other = MockClient((r) async => problem('invalid-signature', 401));
      final a = ApiClient(base: base, client: other, clock: sclock, token: session.accessToken, renew: session.renew);
      await expectLater(a.listDevices(), throwsA(isA<ApiException>().having((e) => e.status, 'status', 401)));
      expect(srv.refreshes, 0);
    });

    test('друга 401 після обміну віддається як є, без циклу', () async {
      await session.signIn('agro', 'secret-password');
      var calls = 0;
      final always = MockClient((r) async {
        if (r.url.path.endsWith('/auth/refresh')) return srv.handle(r);
        calls++;
        return problem('token-revoked', 401);
      });
      final a = ApiClient(base: base, client: always, clock: sclock, token: session.accessToken, renew: session.renew);
      await expectLater(a.listDevices(), throwsA(isA<ApiException>().having((e) => e.code, 'code', 'token-revoked')));
      expect(calls, 2);
    });

    test('привʼязка передає код з корпусу пристрою', () async {
      late http.Request seen;
      final a = ApiClient(
        base: base,
        client: MockClient((r) async {
          seen = r;
          return json({'device': 'gh1', 'owner': 'u'}, 201);
        }),
        clock: sclock,
      );
      await a.claimDevice('gh1', code: 'K7QM-2XWD-9PBA-4FHT');
      expect(jsonDecode(seen.body), {'code': 'K7QM-2XWD-9PBA-4FHT'});
    });
  });

  group('SseClient з обміном токена', () {
    test('401 при підключенні: обмін і друга спроба успішна', () async {
      await session.signIn('agro', 'secret-password');
      srv.valid.clear();
      final seen = <String?>[];
      final client = MockClient.streaming((req, _) async {
        seen.add(req.headers['Authorization']);
        if (!srv.valid.contains(req.headers['Authorization']?.substring(7))) {
          return http.StreamedResponse(const Stream.empty(), 401);
        }
        return http.StreamedResponse(
          Stream.value(utf8.encode('event: ready\ndata: {}\n\n')),
          200,
        );
      });
      // обмін іде через сеанс (інший клієнт), потік — через свій
      final sse = SseClient(
        client: client,
        url: Uri.parse('http://bed.test/s'),
        token: session.accessToken,
        renew: session.renew,
      );
      final first = await sse.events().first;
      expect(first.event, 'ready');
      expect(seen, ['Bearer access-1', 'Bearer access-2']);
    });

    test('обмін відхилено: потік завершується auth-помилкою', () async {
      await session.signIn('agro', 'secret-password');
      srv.valid.clear();
      srv.refreshStatus = 401;
      final client = MockClient.streaming(
        (req, _) async => http.StreamedResponse(const Stream.empty(), 401),
      );
      final sse = SseClient(
        client: client,
        url: Uri.parse('http://bed.test/s'),
        token: session.accessToken,
        renew: session.renew,
      );
      await expectLater(
        sse.events().first,
        throwsA(isA<SessionExpired>()),
      );
    });
  });
}

class _FailingStore extends MemoryTokenStore {
  _FailingStore({required this.failAfter});
  final int failAfter;

  @override
  Future<void> save(Tokens tokens) async {
    if (saves >= failAfter) throw StateError('диск заповнений');
    await super.save(tokens);
  }
}
