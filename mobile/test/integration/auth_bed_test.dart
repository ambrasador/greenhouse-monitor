// Вхід і сеанс на справжньому сервері: клієнт Dart проти еталона розділу 6,
// запущеного з параметром auth (токени, ролі, область доступу).
//
//   BED_DIR=.. flutter test test/integration
//
// Годинником сервера керує стенд: POST /advance зсуває його вперед, тож
// «через 15 хвилин» і «через годину» тест перевіряє за мілісекунди. Годинник
// телефона не зсувається, і клієнт дізнається про спливання токена лише з 401.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:greenhouse_mobile/core/api_client.dart';
import 'package:greenhouse_mobile/core/auth_session.dart';
import 'package:greenhouse_mobile/core/clock.dart';
import 'package:greenhouse_mobile/core/models.dart';
import 'package:greenhouse_mobile/core/push_tokens.dart';
import 'package:greenhouse_mobile/core/sse_client.dart';
import 'package:greenhouse_mobile/core/store.dart';
import 'package:http/http.dart' as http;

import 'bed.dart';

const password = 'correct horse battery'; // auth-kit.js: PASSWORD

/// Користувач, що увійшов: сеанс, клієнт API з обміном токенів і сховище пари.
class Login {
  Login(this.session, this.api, this.store);

  final AuthSession session;
  final ApiClient api;
  final MemoryTokenStore store;
}

ApiClient apiOver(AuthSession session, Uri base) => ApiClient(
  base: base,
  client: http.Client(),
  clock: ServerClock(const SystemClock()),
  token: session.accessToken,
  renew: session.renew,
  timeout: const Duration(seconds: 5),
);

AuthSession sessionOver(Uri base, MemoryTokenStore store) => AuthSession(
  base: base,
  client: http.Client(),
  store: store,
  clock: const SystemClock(),
);

Future<Login> signIn(Bed bed, String user) async {
  final store = MemoryTokenStore();
  final session = sessionOver(bed.api, store);
  await session.signIn(user, password);
  return Login(session, apiOver(session, bed.api), store);
}

Matcher problem(int status, [String? code]) => throwsA(
  isA<ApiException>()
      .having((e) => e.status, 'status', status)
      .having((e) => e.code, 'code', code ?? isNotNull),
);

void main() {
  final dir = Platform.environment['BED_DIR'];
  final skip = dir == null
      ? 'задайте BED_DIR — теку зі serve-mobile-bed.js'
      : null;
  late Bed bed;

  // Кожен тест має власний стенд: зсув годинника й вимкнені облікові записи
  // не мають переходити до сусіднього тесту
  setUp(() async {
    HttpOverrides.global = null;
    bed = await Bed.start(dir!, {
      'auth': {'accessTtlSec': 900, 'refreshTtlSec': 3600},
      'sse': {'heartbeatMs': 100, 'retryMs': 50},
    });
  });
  tearDown(() => bed.stop());

  group('сервер із входом', skip: skip, () {
    test('без входу 401, після входу — лише своя зона', () async {
      await expectLater(
        clientFor(bed.api).listDevices(),
        problem(401, 'unauthorized'),
      );
      final north = await signIn(bed, 'north');
      final list = await north.api.listDevices();
      expect(list.items.map((d) => d.id), ['gh1-s01']);
      // чужий пристрій не відрізнити від неіснуючого
      await expectLater(
        north.api.getDevice('gh1-s02'),
        problem(404, 'device-not-found'),
      );
      await expectLater(
        north.api.getDevice('gh1-nonexistent'),
        problem(404, 'device-not-found'),
      );
    });

    test(
      'неправильний пароль: 401 invalid-credentials, сеансу немає',
      () async {
        final session = sessionOver(bed.api, MemoryTokenStore());
        await expectLater(
          session.signIn('north', 'wrong horse battery'),
          problem(401, 'invalid-credentials'),
        );
        expect(session.signedIn, isFalse);
      },
    );

    test('токен спливає: один обмін на всі паралельні запити', () async {
      final u = await signIn(bed, 'north');
      final loginTokens = u.store.value!;
      await bed.post('/advance', {'sec': 901}); // 900 с життя + 1
      final lists = await Future.wait([
        for (var i = 0; i < 5; i++) u.api.listDevices(),
      ]);
      expect(lists.every((l) => l.items.length == 1), isTrue);
      // вхід + рівно один обмін: п’ять запитів дістали п’ять 401, а обмін один
      expect(u.store.saves, 2);
      expect(u.store.value!.access, isNot(loginTokens.access));
      expect(u.store.value!.refresh, isNot(loginTokens.refresh));
    });

    test(
      'refresh-токен спливає: SessionExpired і порожнє сховище',
      () async {
        final u = await signIn(bed, 'north');
        final seen = <bool>[];
        u.session.changes.listen(seen.add);
        await bed.post('/advance', {'sec': 3601});
        await expectLater(
          u.api.listDevices(),
          throwsA(isA<SessionExpired>()),
        );
        expect(u.session.signedIn, isFalse);
        expect(u.store.value, isNull);
        await pumpEventQueue();
        expect(seen, [false]);
      },
    );

    test(
      'крадіжка refresh-токена: повторне пред’явлення гасить родину',
      () async {
        final owner = await signIn(bed, 'north');
        final thief = sessionOver(
          bed.api,
          MemoryTokenStore()..value = owner.store.value,
        );
        await thief.restore();
        await thief.renew(null); // злодій обміняв першим, у нього нова пара

        await bed.post('/advance', {'sec': 11}); // за межею 10 с
        await expectLater(
          owner.session.renew(
            null,
          ), // власник пред’являє вже використаний токен
          throwsA(isA<SessionExpired>()),
        );
        // сервер анулював усю родину: нова пара злодія теж марна
        await expectLater(
          thief.renew(null),
          throwsA(isA<SessionExpired>()),
        );
        expect(
          (await bed.stats())['audit'],
          contains('refresh.reuse:revoked'),
        );
      },
    );

    test(
      'втрачена відповідь обміну: повтор за 10 с не гасить родину',
      () async {
        final u = await signIn(bed, 'north');
        final second = sessionOver(
          bed.api,
          MemoryTokenStore()..value = u.store.value,
        );
        await second.restore();
        await second.renew(
          null,
        ); // «перша спроба», відповідь якої не дійшла
        await u.session.renew(
          null,
        ); // повтор тим самим токеном, секунди потому
        expect(u.session.signedIn, isTrue);
        expect(
          (await bed.stats())['audit'],
          isNot(contains('refresh.reuse:revoked')),
        );
      },
    );

    test(
      'вимкнений обліковий запис: потік закривається, сеанс завершується',
      () async {
        final u = await signIn(bed, 'north');
        final sse = SseClient(
          client: http.Client(),
          url: bed.api.resolve('devices/gh1-s01/stream'),
          token: u.session.accessToken,
          renew: u.session.renew,
        );
        final got = <SseEvent>[];
        final end = Completer<Object?>();
        void finish(Object? how) {
          if (!end.isCompleted) end.complete(how);
        }

        sse.events().listen(
          got.add,
          onError: finish,
          onDone: () => finish(null),
        );
        await eventually(
          () async => got.any((e) => e.event == 'ready') ? true : null,
        );

        await bed.post('/auth/disable', {'username': 'north'});
        // heartbeat (100 мс) бачить вимкнення й закриває потік; повторне
        // з’єднання дістає 401, обмін refresh — invalid-grant
        expect(
          await end.future.timeout(const Duration(seconds: 5)),
          isA<SessionExpired>(),
        );
        await expectLater(u.api.listDevices(), problem(401));
      },
    );

    test('роль viewer читає, але команд не надсилає', () async {
      final viewer = await signIn(bed, 'viewer');
      expect((await viewer.api.listDevices()).items, isNotEmpty);
      await expectLater(
        viewer.api.sendCommand('gh1-s01', 'irrigate', {
          'duration_sec': 5,
        }, idempotencyKey: 'viewer-key-0001'),
        problem(403, 'forbidden'),
      );
      final op = await signIn(bed, 'north');
      final cmd = await op.api.sendCommand('gh1-s01', 'irrigate', {
        'duration_sec': 5,
      }, idempotencyKey: 'north-key-0001');
      expect(cmd.status, isIn([CommandStatus.pending, CommandStatus.sent]));
    });

    test(
      'вихід: push знято до виходу, refresh-токен більше не діє',
      () async {
        final u = await signIn(bed, 'north');
        const fid = 'fid_north_android_0123456789abcdef';
        await bed.post('/fcm/valid-token', {'token': fid});
        final registrar = TokenRegistrar(
          api: u.api,
          store: MemoryStore(),
          clock: const SystemClock(),
          platform: 'android',
        );
        await registrar.ensure(const PushTarget.fid(fid));
        expect((await bed.stats())['tokens'], hasLength(1));

        final refresh = u.store.value!.refresh;
        await registrar
            .forget(); // після виходу цей запит уже не пройшов би
        await u.session.signOut();
        expect((await bed.stats())['tokens'], isEmpty);
        expect(u.store.value, isNull);

        final r = await http.post(
          bed.api.resolve('auth/refresh'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'refresh_token': refresh}),
        );
        expect(r.statusCode, 401);
      },
    );

    test(
      'вихід без forget(): адресу прибирає сервер, бо вона прив’язана до сеансу',
      () async {
        final u = await signIn(bed, 'north');
        const fid = 'fid_north_android_0123456789abcdef';
        await bed.post('/fcm/valid-token', {'token': fid});
        final registrar = TokenRegistrar(
          api: u.api,
          store: MemoryStore(),
          clock: const SystemClock(),
          platform: 'android',
        );
        await registrar.ensure(const PushTarget.fid(fid));
        expect((await bed.stats())['tokens'], hasLength(1));

        // Застосунок без мережі не встиг викликати forget(); запит виходу
        // дійшов до сервера пізніше, і токена доступу для DELETE вже немає
        await u.session.signOut();
        expect((await bed.stats())['tokens'], isEmpty);
      },
    );

    test(
      'код прив’язки: без коду й з хибним 403, з вірним — пристрій мій',
      () async {
        final op = await signIn(bed, 'north');
        await bed.reading('gh1-new', 'temperature', 21.5, DateTime.now());
        // «немає коду» і «хибний код» неможливо відрізнити за відповіддю
        for (final code in <String?>[null, 'AAAA-BBBB-CCCC-DDDD']) {
          await expectLater(
            op.api.claimDevice('gh1-new', code: code),
            problem(403, 'invalid-claim-code'),
          );
        }
        final code =
            (await bed.post('/auth/claim-code', {
                  'device': 'gh1-new',
                }))['code']
                as String;
        await op.api.claimDevice('gh1-new', code: code);
        expect(
          (await op.api.listDevices()).items.map((d) => d.id),
          containsAll(['gh1-s01', 'gh1-new']),
        );
        // код погашено успішною прив’язкою
        final agro = await signIn(bed, 'agro');
        await expectLater(
          agro.api.claimDevice('gh1-new', code: code),
          problem(403, 'invalid-claim-code'),
        );
      },
    );
  });
}
