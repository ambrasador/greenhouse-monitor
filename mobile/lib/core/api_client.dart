import 'dart:async';
import 'dart:convert';
import 'dart:io' show HttpDate, SocketException;

import 'package:http/http.dart' as http;

import 'clock.dart';
import 'merge.dart';
import 'models.dart';

/// Як клієнт має поводитися після відмови.
enum FailureKind {
  /// Відповіді не було або сервер просить зачекати: спробувати ще раз
  /// з тим самим ключем.
  transient,

  /// 401: потрібен новий токен, чергу ставимо на паузу.
  auth,

  /// 412: дані на сервері змінилися, вирішує користувач.
  conflict,

  /// Інші 4xx: повтор нічого не змінить.
  rejected,
}

class ApiException implements Exception {
  ApiException({
    required this.status,
    this.code,
    this.title,
    this.retryAfter,
    this.extra = const {},
    this.cause,
  });

  /// HTTP-код; 0 — відповіді не було (обрив, тайм-аут, немає мережі).
  final int status;

  /// Хвіст поля `type` з problem+json, наприклад `device-not-found`.
  final String? code;
  final String? title;
  final Duration? retryAfter;
  final Map<String, dynamic> extra;
  final Object? cause;

  FailureKind get kind => switch (status) {
    0 || 408 || 425 || 429 => FailureKind.transient,
    >= 500 => FailureKind.transient,
    401 => FailureKind.auth,
    412 => FailureKind.conflict,
    _ => FailureKind.rejected,
  };

  @override
  String toString() => 'ApiException($status, $code, $title)';
}

/// Refresh-токен відхилено (invalid-grant): сеанс завершено, потрібен новий
/// вхід. Це 401, тож черга й потоки реагують на нього як на будь-яку auth-помилку.
class SessionExpired extends ApiException {
  SessionExpired()
    : super(status: 401, code: 'session-expired', title: 'потрібен вхід');
}

typedef TokenProvider = Future<String?> Function();

/// Обмін пари токенів після 401. [used] — токен, з яким запит дістав відмову:
/// якщо пару вже оновлено, ще один обмін не потрібен. Кидає [SessionExpired],
/// коли відновити сеанс неможливо.
typedef TokenRenewer = Future<void> Function(String used);

/// Типи Problem, за якими 401 означає «токен непридатний».
const _badToken = {'token-expired', 'invalid-token', 'token-revoked'};

/// Помилка за відповіддю problem+json; спільна для API і сеансу входу.
ApiException problemFrom(http.Response res, Clock clock) {
  Map<String, dynamic> body = const {};
  try {
    final j = jsonDecode(utf8.decode(res.bodyBytes));
    if (j is Map<String, dynamic>) body = j;
  } on FormatException {
    // відповідь проксі чи балансувальника не є problem+json
  }
  final type = body['type'] as String?;
  return ApiException(
    status: res.statusCode,
    code: type?.split('/').last,
    title: body['title'] as String? ?? res.reasonPhrase,
    retryAfter: _retryAfter(res.headers['retry-after'], clock),
    extra: body,
  );
}

Duration? _retryAfter(String? header, Clock clock) {
  if (header == null) return null;
  final seconds = int.tryParse(header.trim());
  if (seconds != null) return Duration(seconds: seconds);
  try {
    final at = HttpDate.parse(header);
    final wait = at.difference(clock.now());
    return wait.isNegative ? Duration.zero : wait;
  } on Object {
    return null;
  }
}

class ApiClient {
  ApiClient({
    required this.base,
    required this.client,
    required this.clock,
    this.token,
    this.renew,
    this.defaultHeaders = const {},
    this.timeout = const Duration(seconds: 10),
  });

  /// Корінь API з косою рискою в кінці: `https://host/api/v1/`.
  final Uri base;
  final http.Client client;
  final ServerClock clock;
  final TokenProvider? token;

  /// Що робити після 401 «токен непридатний»: один обмін і один повтор.
  final TokenRenewer? renew;

  /// Заголовки на кожен запит (у стенді розділу 5 — `X-User`).
  final Map<String, String> defaultHeaders;
  final Duration timeout;

  Future<http.Response> _send(
    String method,
    String path, {
    Map<String, String>? query,
    Object? body,
    Map<String, String> headers = const {},
  }) async {
    for (var attempt = 0; ; attempt++) {
      final bearer = await token?.call();
      final res = await _roundTrip(method, path, query, body, headers, bearer);
      if (res.statusCode == 401 &&
          attempt == 0 &&
          bearer != null &&
          renew != null &&
          _badToken.contains(_problem(res).code)) {
        await renew!(bearer); // кидає SessionExpired, якщо сеанс не відновити
        continue;
      }
      if (res.statusCode >= 400) throw _problem(res);
      return res;
    }
  }

  Future<http.Response> _roundTrip(
    String method,
    String path,
    Map<String, String>? query,
    Object? body,
    Map<String, String> headers,
    String? bearer,
  ) async {
    // Запит одноразовий: для повтору після обміну токена будуємо новий
    final request = http.Request(
      method,
      base.resolve(path).replace(queryParameters: query),
    )..headers['Accept'] = 'application/json';
    if (bearer != null) request.headers['Authorization'] = 'Bearer $bearer';
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    request.headers
      ..addAll(defaultHeaders)
      ..addAll(headers);

    final sent = clock.local.now();
    final http.Response res;
    try {
      res = await Future(() async {
        return http.Response.fromStream(await client.send(request));
      }).timeout(timeout);
    } on TimeoutException catch (e) {
      throw ApiException(status: 0, title: 'тайм-аут', cause: e);
    } on SocketException catch (e) {
      throw ApiException(status: 0, title: 'немає мережі', cause: e);
    } on http.ClientException catch (e) {
      throw ApiException(status: 0, title: 'обрив зв’язку', cause: e);
    }
    clock.observe(res.headers['date'], sent, clock.local.now());
    return res;
  }

  ApiException _problem(http.Response res) => problemFrom(res, clock);

  Map<String, dynamic> _json(http.Response r) =>
      jsonDecode(utf8.decode(r.bodyBytes)) as Map<String, dynamic>;

  Future<Listing<DeviceInfo>> listDevices({
    String? cursor,
    int limit = 50,
  }) async {
    final r = await _send(
      'GET',
      'devices',
      query: {'limit': '$limit', 'cursor': ?cursor},
    );
    final j = _json(r);
    return Listing([
      for (final d in j['data'] as List<dynamic>)
        DeviceInfo.fromJson(d as Map<String, dynamic>),
    ], j['next'] as String?);
  }

  Future<DeviceInfo> getDevice(String id) async =>
      DeviceInfo.fromJson(_json(await _send('GET', 'devices/$id')));

  Future<TelemetryPage> telemetry({
    required String device,
    required String metric,
    required DateTime from,
    required DateTime to,
    String? cursor,
    int limit = 1000,
  }) async {
    final r = await _send(
      'GET',
      'telemetry',
      query: {
        'device': device,
        'metric': metric,
        'from': formatTs(from),
        'to': formatTs(to),
        'limit': '$limit',
        'cursor': ?cursor,
      },
    );
    final j = _json(r);
    return TelemetryPage([
      for (final p in j['data'] as List<dynamic>)
        Point(
          DateTime.parse((p as Map<String, dynamic>)['ts'] as String)
              .millisecondsSinceEpoch,
          (p['value'] as num).toDouble(),
        ),
    ], j['next'] as String?);
  }

  /// Надсилає команду. Той самий [idempotencyKey] при повторі повертає
  /// ту саму команду (202), а не створює другу.
  Future<CommandRecord> sendCommand(
    String deviceId,
    String name,
    Map<String, Object?> params, {
    required String idempotencyKey,
  }) async {
    final r = await _send(
      'POST',
      'devices/$deviceId/commands',
      body: {'name': name, 'params': params},
      headers: {'Idempotency-Key': idempotencyKey},
    );
    return CommandRecord.fromJson(_json(r));
  }

  Future<CommandRecord> getCommand(String id) async =>
      CommandRecord.fromJson(_json(await _send('GET', 'commands/$id')));

  Future<SettingsDoc> getSettings(String deviceId) async {
    final r = await _send('GET', 'devices/$deviceId/settings');
    return SettingsDoc(
      _json(r).cast<String, Object?>(),
      r.headers['etag']!,
    );
  }

  /// Замінює налаштування, якщо ETag на сервері ще [ifMatch]. Інакше
  /// 412 з полями `current` і `current_etag` у [ApiException.extra].
  Future<SettingsDoc> putSettings(
    String deviceId,
    Map<String, Object?> body, {
    required String ifMatch,
  }) async {
    final r = await _send(
      'PUT',
      'devices/$deviceId/settings',
      body: body,
      headers: {'If-Match': ifMatch},
    );
    return SettingsDoc(
      _json(r).cast<String, Object?>(),
      r.headers['etag']!,
    );
  }

  /// Повідомляє серверу адресу push; ім’я поля тіла збігається з видом.
  Future<void> registerPush(PushTarget target, String platform) async {
    await _send(
      'POST',
      'push-tokens',
      body: {target.kind.name: target.id, 'platform': platform},
    );
  }

  Future<void> unregisterPush(String id) async {
    await _send('DELETE', 'push-tokens/${Uri.encodeComponent(id)}');
  }

  /// Прив'язує пристрій. Сервер із ввімкненою безпекою вимагає [code] з
  /// корпусу пристрою; стенд розділу 5 обходиться без нього.
  Future<void> claimDevice(String deviceId, {String? code}) async {
    await _send(
      'POST',
      'devices/$deviceId/claim',
      body: code == null ? null : {'code': code},
    );
  }
}
