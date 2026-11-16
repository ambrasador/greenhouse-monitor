import 'dart:convert';

import 'api_client.dart';
import 'clock.dart';
import 'models.dart';
import 'store.dart';

/// Реєстрація адреси push на сервері. Адресу видає SDK; запис про неї
/// лежить у сховищі ще до звернення до сервера, тож невдала реєстрація
/// не губиться, а повторюється при наступному запуску. FCM радить оновлювати
/// мітку часу адреси щонайменше раз на місяць; тут — раз на [refreshEvery].
class TokenRegistrar {
  TokenRegistrar({
    required this.api,
    required this.store,
    required this.clock,
    required this.platform,
    this.refreshEvery = const Duration(days: 7),
  });

  static const _key = 'push/registered';

  final ApiClient api;
  final KeyValueStore store;
  final Clock clock;
  final String platform;
  final Duration refreshEvery;

  Future<({PushTarget target, DateTime? at})?> _read() async {
    final raw = await store.read(_key);
    if (raw == null) return null;
    final j = jsonDecode(raw) as Map<String, dynamic>;
    return (
      target: PushTarget(
        PushKind.values.byName(j['kind'] as String),
        j['id'] as String,
      ),
      at: j['at'] == null ? null : DateTime.parse(j['at'] as String),
    );
  }

  Future<void> _write(PushTarget t, DateTime? at) => store.write(
    _key,
    jsonEncode({
      'kind': t.kind.name,
      'id': t.id,
      'at': at?.toIso8601String(),
    }),
  );

  /// SDK повідомив адресу: нову реєструємо одразу, ту саму — раз на
  /// [refreshEvery].
  Future<void> ensure(PushTarget? target) async {
    if (target == null) return;
    final saved = await _read();
    if (saved == null || saved.target != target) {
      await _write(target, null); // адресу запам’ятали, сервер ще не знає
    } else if (saved.at != null &&
        clock.now().difference(saved.at!) < refreshEvery) {
      return;
    }
    await api.registerPush(target, platform);
    await _write(target, clock.now());
  }

  /// Нагадує серверу збережену адресу, якщо реєстрація не вдалася або
  /// застаріла. Не покладається на те, що SDK повідомляє адресу при
  /// кожному запуску: цього не перевірено.
  Future<void> refreshIfDue() async {
    final saved = await _read();
    if (saved == null) return;
    final at = saved.at;
    if (at == null || clock.now().difference(at) >= refreshEvery) {
      await ensure(saved.target);
    }
  }

  /// Вихід з облікового запису: сервер перестає слати push на цей пристрій.
  Future<void> forget() async {
    final saved = await _read();
    if (saved == null) return;
    await api.unregisterPush(saved.target.id);
    await store.remove(_key);
  }
}
