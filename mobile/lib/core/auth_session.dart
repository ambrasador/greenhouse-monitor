import 'dart:async';
import 'dart:convert';
import 'dart:io' show SocketException;

import 'package:http/http.dart' as http;

import 'api_client.dart';
import 'clock.dart';

/// Пара токенів і момент, коли токен доступу спливе за годинником телефона.
class Tokens {
  const Tokens({
    required this.access,
    required this.refresh,
    required this.expiresAt,
  });

  final String access;
  final String refresh;
  final DateTime expiresAt;

  Map<String, Object?> toJson() => {
    'access': access,
    'refresh': refresh,
    'expires_at': expiresAt.millisecondsSinceEpoch,
  };

  factory Tokens.fromJson(Map<String, dynamic> j) => Tokens(
    access: j['access'] as String,
    refresh: j['refresh'] as String,
    expiresAt: DateTime.fromMillisecondsSinceEpoch(
      j['expires_at'] as int,
      isUtc: true,
    ),
  );
}

/// Де пара лежить між запусками. Робоча реалізація — Keychain на iOS і
/// Keystore на Android (platform/secure_token_store.dart), а не
/// SharedPreferences: ті лишають значення відкритим текстом у файлі застосунку.
abstract interface class TokenStore {
  Future<Tokens?> load();
  Future<void> save(Tokens tokens);
  Future<void> clear();
}

/// Сховище в пам'яті: для тестів і для режиму «без запам'ятовування входу».
class MemoryTokenStore implements TokenStore {
  Tokens? value;
  int saves = 0;

  @override
  Future<Tokens?> load() async => value;

  @override
  Future<void> save(Tokens tokens) async {
    value = tokens;
    saves++;
  }

  @override
  Future<void> clear() async => value = null;
}

/// Сеанс користувача. Усі запити отримують токен через [accessToken], а на
/// 401 звертаються до [renew]. Refresh-токен одноразовий, тож обмін один на
/// всіх: паралельні запити чекають той самий [Future].
class AuthSession {
  AuthSession({
    required this.base,
    required this.client,
    required this.store,
    required this.clock,
    this.skew = const Duration(seconds: 30),
    this.timeout = const Duration(seconds: 10),
  });

  /// Корінь API з косою рискою в кінці: `https://host/api/v1/`.
  final Uri base;
  final http.Client client;
  final TokenStore store;
  final Clock clock;

  /// За скільки до кінця токен оновлюється заздалегідь.
  final Duration skew;
  final Duration timeout;

  Tokens? _tokens;
  bool _loaded = false;
  Future<void>? _inflight;
  final _changes = StreamController<bool>.broadcast();

  /// `true` — користувач увійшов, `false` — сеанс завершено.
  Stream<bool> get changes => _changes.stream;
  bool get signedIn => _tokens != null;

  /// Підхоплює пару зі сховища після запуску застосунку.
  Future<void> restore() async {
    _tokens = await store.load();
    _loaded = true;
    if (_tokens != null) _changes.add(true);
  }

  Future<http.Response> _post(String path, Map<String, Object?> body) async {
    try {
      return await client
          .post(
            base.resolve(path),
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: jsonEncode(body),
          )
          .timeout(timeout);
    } on TimeoutException catch (e) {
      throw ApiException(status: 0, title: 'тайм-аут', cause: e);
    } on SocketException catch (e) {
      throw ApiException(status: 0, title: 'немає мережі', cause: e);
    } on http.ClientException catch (e) {
      throw ApiException(status: 0, title: 'обрив зв’язку', cause: e);
    }
  }

  Future<void> _keep(http.Response res) async {
    final j = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    final next = Tokens(
      access: j['access_token'] as String,
      refresh: j['refresh_token'] as String,
      expiresAt: clock.now().add(Duration(seconds: j['expires_in'] as int)),
    );
    // Спершу пам'ять: сервер уже обернув токен, і стара пара марна. Збій запису
    // не має відкинути нову: наступний обмін збереже її знову
    _tokens = next;
    try {
      await store.save(next);
    } on Object {
      // лишилась у пам'яті
    }
  }

  Future<void> signIn(String username, String password) async {
    final res = await _post('auth/login', {
      'username': username,
      'password': password,
    });
    if (res.statusCode != 200) throw problemFrom(res, clock);
    await _keep(res);
    _loaded = true;
    _changes.add(true);
  }

  Future<void> _drop() async {
    _tokens = null;
    try {
      await store.clear();
    } on Object {
      // стару пару сервер уже анулював
    }
    _changes.add(false);
  }

  Future<void> _exchange(Tokens t) async {
    final res = await _post('auth/refresh', {'refresh_token': t.refresh});
    if (res.statusCode == 400 || res.statusCode == 401) {
      await _drop(); // invalid-grant: родину анульовано
      throw SessionExpired();
    }
    if (res.statusCode != 200) throw problemFrom(res, clock);
    await _keep(res);
  }

  /// Обмін після 401. [used] — токен, з яким запит дістав відмову: якщо пару
  /// вже оновлено, ще один обмін зламав би ланцюг (старий токен — це
  /// повторне пред'явлення).
  Future<void> renew(String? used) {
    final t = _tokens;
    if (t == null) return Future.error(SessionExpired());
    if (used != null && t.access != used) return Future.value();
    return _inflight ??= _exchange(t).whenComplete(() => _inflight = null);
  }

  /// Токен для заголовка Authorization; `null`, якщо користувач не входив.
  Future<String?> accessToken() async {
    if (!_loaded) await restore();
    final t = _tokens;
    if (t == null) return null;
    if (t.expiresAt.difference(clock.now()) < skew) {
      try {
        await renew(null);
      } on SessionExpired {
        rethrow;
      } on ApiException {
        // Збій обміну (мережа, 5xx): поки токен чинний, працюємо з ним
        if (!clock.now().isBefore(t.expiresAt)) rethrow;
      }
    }
    return _tokens?.access;
  }

  /// Вихід: спершу локально, щоб він не залежав від мережі; сервер повідомляємо
  /// за можливості.
  Future<void> signOut() async {
    final refresh = _tokens?.refresh;
    if (_tokens != null) await _drop();
    if (refresh == null) return;
    try {
      await _post('auth/logout', {'refresh_token': refresh});
    } on ApiException {
      // refresh-токен спливе сам
    }
  }
}
