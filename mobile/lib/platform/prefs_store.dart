import 'package:shared_preferences/shared_preferences.dart';

import '../core/store.dart';

/// Робоче сховище телефона: `SharedPreferencesAsync`. Локального кешу в
/// нього немає, тому кожне читання асинхронне й бачить записи інших ізолятів;
/// на Android за замовчуванням працює DataStore Preferences, на iOS —
/// NSUserDefaults.
class PrefsStore implements KeyValueStore {
  PrefsStore([SharedPreferencesAsync? prefs])
    : _prefs = prefs ?? SharedPreferencesAsync();

  final SharedPreferencesAsync _prefs;

  @override
  Future<String?> read(String key) => _prefs.getString(key);

  @override
  Future<void> write(String key, String value) =>
      _prefs.setString(key, value);

  @override
  Future<void> remove(String key) => _prefs.remove(key);

  @override
  Future<List<String>> keys(String prefix) async =>
      (await _prefs.getKeys()).where((k) => k.startsWith(prefix)).toList()
        ..sort();
}
