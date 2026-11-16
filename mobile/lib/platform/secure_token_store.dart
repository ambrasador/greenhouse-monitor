import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../core/auth_session.dart';

/// Пара токенів у Keychain (iOS) і Keystore (Android). SharedPreferences для
/// цього не годяться: вони лежать у файлі застосунку відкритим текстом, і
/// резервна копія забирає їх разом з усім іншим.
///
/// `first_unlock_this_device`: фонова задача після перезапуску телефона читає
/// токен без того, щоб користувач розблокував екран знову; запис не переходить
/// на інший пристрій через резервну копію. На Android слід вимкнути автобекап
/// (`android:allowBackup="false"`) — інакше після відновлення ключ у Keystore
/// не збігається з даними й читання кидає InvalidKeyException.
class SecureTokenStore implements TokenStore {
  SecureTokenStore([FlutterSecureStorage? storage])
    : _storage =
          storage ??
          const FlutterSecureStorage(
            iOptions: IOSOptions(
              accessibility: KeychainAccessibility.first_unlock_this_device,
            ),
          );

  static const _key = 'auth.tokens';
  final FlutterSecureStorage _storage;

  @override
  Future<Tokens?> load() async {
    final raw = await _storage.read(key: _key);
    if (raw == null) return null;
    try {
      return Tokens.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } on Object {
      await clear(); // пошкоджений запис не відрізнити від відсутнього
      return null;
    }
  }

  @override
  Future<void> save(Tokens tokens) =>
      _storage.write(key: _key, value: jsonEncode(tokens.toJson()));

  @override
  Future<void> clear() => _storage.delete(key: _key);
}
