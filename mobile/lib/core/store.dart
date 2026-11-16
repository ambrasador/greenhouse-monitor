import 'dart:convert';

/// Найменший спільний знаменник локальних сховищ: рядок за ключем.
/// Чергу, кеш і налаштування застосунок будує поверх нього, а тест
/// підставляє пам’ять.
abstract interface class KeyValueStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> remove(String key);

  /// Ключі з префіксом, у лексикографічному порядку.
  Future<List<String>> keys(String prefix);
}

/// Сховище в пам’яті з лічильниками: скільки разів і скільки байтів
/// записано. Лічильники потрібні вимірюванню, а не застосунку.
class MemoryStore implements KeyValueStore {
  final Map<String, String> _data = {};
  int writes = 0;
  int bytesWritten = 0;

  @override
  Future<String?> read(String key) async => _data[key];

  @override
  Future<void> write(String key, String value) async {
    _data[key] = value;
    writes++;
    bytesWritten += utf8.encode(key).length + utf8.encode(value).length;
  }

  @override
  Future<void> remove(String key) async => _data.remove(key);

  @override
  Future<List<String>> keys(String prefix) async =>
      _data.keys.where((k) => k.startsWith(prefix)).toList()..sort();
}
