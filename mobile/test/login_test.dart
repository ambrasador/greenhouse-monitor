import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:greenhouse_mobile/core/api_client.dart';
import 'package:greenhouse_mobile/core/auth_session.dart';
import 'package:greenhouse_mobile/core/cache.dart';
import 'package:greenhouse_mobile/core/clock.dart';
import 'package:greenhouse_mobile/core/live_series.dart';
import 'package:greenhouse_mobile/core/offline_queue.dart';
import 'package:greenhouse_mobile/core/repository.dart';
import 'package:greenhouse_mobile/core/store.dart';
import 'package:greenhouse_mobile/main.dart';
import 'package:greenhouse_mobile/ui/login_screen.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response json(Object body, int status, [Map<String, String> h = const {}]) =>
    http.Response.bytes(
      utf8.encode(jsonEncode(body)),
      status,
      headers: {'content-type': 'application/json', ...h},
    );

http.Response problem(String kind, int status, [Map<String, String> h = const {}]) =>
    json({'type': 'https://greenhouse.example/problems/$kind', 'title': kind, 'status': status}, status, h);

void main() {
  final t0 = DateTime.utc(2026, 11, 5, 9);
  late ManualClock local;
  late ServerClock clock;
  late MemoryStore store;
  late MemoryTokenStore tokens;
  late AuthSession session;
  late ApiClient api;
  var logins = <Map<String, dynamic>>[];

  Future<http.Response> server(http.Request r) async {
    if (r.url.path.endsWith('/auth/login')) {
      final b = jsonDecode(r.body) as Map<String, dynamic>;
      logins.add(b);
      return switch (b['password']) {
        'good-password-1' => json({
          'token_type': 'Bearer',
          'access_token': 'a1',
          'refresh_token': 'refresh-token-number-1',
          'expires_in': 900,
        }, 200),
        'slow-down' => problem('rate-limited', 429, {'retry-after': '41'}),
        'boom' => problem('internal', 500),
        _ => problem('invalid-credentials', 401),
      };
    }
    if (r.url.path.endsWith('/devices')) {
      return json({
        'data': [
          {
            'id': 'gh1',
            'name': 'Грядка А',
            'zone': 'north',
            'created_at': t0.toIso8601String(),
            'last_seen': t0.toIso8601String(),
          },
        ],
        'next': null,
      }, 200);
    }
    return problem('not-found', 404);
  }

  setUp(() {
    local = ManualClock(t0);
    clock = ServerClock(local);
    store = MemoryStore();
    tokens = MemoryTokenStore();
    logins = [];
    final client = MockClient(server);
    session = AuthSession(
      base: Uri.parse('http://bed.test/api/v1/'),
      client: client,
      store: tokens,
      clock: local,
    );
    api = ApiClient(
      base: Uri.parse('http://bed.test/api/v1/'),
      client: client,
      clock: clock,
      token: session.accessToken,
      renew: session.renew,
    );
  });

  Widget app() => GreenhouseApp(
    repo: DeviceRepository(api: api, cache: JsonCache(store, clock), clock: clock),
    queue: OfflineQueue(store: store, api: api, clock: local, newId: () => 'key-00000001'),
    clock: clock,
    liveFor: (id, metric) => LiveSeries(
      metric: metric ?? 'soil_moisture',
      window: const Duration(hours: 1),
      open: () => const Stream.empty(),
      history: (a, b, c) async => throw UnimplementedError(),
      clock: local,
    ),
    session: session,
  );

  Future<void> typeAndSubmit(WidgetTester tester, String name, String password) async {
    await tester.enterText(find.widgetWithText(TextField, 'Ім’я користувача'), name);
    await tester.enterText(find.widgetWithText(TextField, 'Пароль'), password);
    await tester.tap(find.text('Увійти'));
    await tester.pumpAndSettle();
  }

  testWidgets('без входу відкривається форма, а не список', (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(find.byType(LoginScreen), findsOneWidget);
    expect(find.text('Грядка А'), findsNothing);
    final field = tester.widget<TextField>(find.widgetWithText(TextField, 'Пароль'));
    expect(field.obscureText, isTrue);
    expect(field.enableSuggestions, isFalse);
  });

  testWidgets('хибний пароль: одне повідомлення, поле пароля очищено', (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    await typeAndSubmit(tester, 'agro', 'wrong');
    expect(find.text('Невірне ім’я користувача або пароль'), findsOneWidget);
    expect(tester.widget<TextField>(find.widgetWithText(TextField, 'Пароль')).controller!.text, isEmpty);
    expect(find.byType(LoginScreen), findsOneWidget);
  });

  testWidgets('429 називає, скільки чекати; 500 має своє повідомлення', (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    await typeAndSubmit(tester, 'agro', 'slow-down');
    expect(find.text('Забагато спроб. Повторіть через 41 с'), findsOneWidget);
    await typeAndSubmit(tester, 'agro', 'boom');
    expect(find.text('Сервер тимчасово недоступний. Спробуйте ще раз'), findsOneWidget);
  });

  testWidgets('успішний вхід відкриває список; ім’я обрізано, пароль без змін', (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    await typeAndSubmit(tester, '  agro ', 'good-password-1');
    expect(find.byType(LoginScreen), findsNothing);
    expect(find.text('Грядка А'), findsOneWidget);
    expect(logins.single, {'username': 'agro', 'password': 'good-password-1'});
    expect(tokens.value?.access, 'a1');
  });

  testWidgets('завершення сеансу повертає на вхід, і назад з нього не вийти', (tester) async {
    await session.signIn('agro', 'good-password-1');
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(find.text('Грядка А'), findsOneWidget);
    await session.signOut();
    await tester.pumpAndSettle();
    expect(find.byType(LoginScreen), findsOneWidget);
    final nav = tester.state<NavigatorState>(find.byType(Navigator));
    expect(nav.canPop(), isFalse, reason: 'стек очищено');
  });

  testWidgets('посилання зі сповіщення без входу веде на вхід', (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    final nav = tester.state<NavigatorState>(find.byType(Navigator));
    unawaited(nav.pushNamed<void>('/devices/gh1'));
    await tester.pumpAndSettle();
    expect(find.byType(LoginScreen), findsWidgets);
    expect(find.text('Температура повітря, останні 6 год'), findsNothing);
  });
}
