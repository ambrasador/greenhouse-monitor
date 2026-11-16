import 'dart:convert';

import 'clock.dart';
import 'store.dart';

/// Значення з кешу разом із моментом збереження: за ним екран пише
/// «дані станом на …» і вирішує, чи вони ще придатні.
class Cached<T> {
  const Cached(this.value, this.savedAt);

  final T value;
  final DateTime savedAt;

  Duration age(DateTime now) => now.difference(savedAt);
}

/// JSON-кеш поверх [KeyValueStore]. Запис — конверт `{v, savedAt, value}`:
/// версія схеми відсікає записи старої програми, а пошкоджений запис
/// читається як «кешу немає» і видаляється, а не валить екран.
class JsonCache {
  JsonCache(this._store, this._clock, {this.schema = 1});

  final KeyValueStore _store;
  final Clock _clock;
  final int schema;

  Future<void> put(String key, Object? json) => _store.write(
    key,
    jsonEncode({
      'v': schema,
      'savedAt': _clock.now().toIso8601String(),
      'value': json,
    }),
  );

  Future<Cached<Object?>?> get(String key) async {
    final raw = await _store.read(key);
    if (raw == null) return null;
    try {
      final env = jsonDecode(raw) as Map<String, dynamic>;
      if (env['v'] != schema) return null;
      return Cached(env['value'], DateTime.parse(env['savedAt'] as String));
    } on Object {
      await _store.remove(key);
      return null;
    }
  }
}
