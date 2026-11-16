import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:greenhouse_mobile/core/cache.dart';
import 'package:greenhouse_mobile/core/clock.dart';
import 'package:greenhouse_mobile/core/store.dart';
import 'package:greenhouse_mobile/platform/prefs_store.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:shared_preferences_platform_interface/in_memory_shared_preferences_async.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_async_platform_interface.dart';

void main() {
  final t0 = DateTime.utc(2026, 11, 4, 12);

  test('запис і читання з міткою часу', () async {
    final clock = ManualClock(t0);
    final cache = JsonCache(MemoryStore(), clock);
    await cache.put('devices', {'n': 4});
    clock.advance(const Duration(minutes: 5));
    final hit = await cache.get('devices');
    expect(hit!.value, {'n': 4});
    expect(hit.savedAt, t0);
    expect(hit.age(clock.now()), const Duration(minutes: 5));
  });

  test(
    'відсутній, пошкоджений і чужої версії запис — «кешу немає»',
    () async {
      final store = MemoryStore();
      final cache = JsonCache(store, ManualClock(t0));
      expect(await cache.get('x'), isNull);

      await store.write(
        'broken',
        '{"v":1,"savedAt":"2026-1',
      ); // обрізаний запис
      expect(await cache.get('broken'), isNull);
      expect(await store.read('broken'), isNull, reason: 'сміття видалено');

      await store.write(
        'old',
        jsonEncode({'v': 0, 'savedAt': '2026-01-01T00:00:00Z', 'value': 1}),
      );
      expect(await cache.get('old'), isNull);
    },
  );

  test('MemoryStore рахує записи й байти', () async {
    final s = MemoryStore();
    await s.write('ab', 'cde'); // 2 + 3 байти
    await s.write('к', 'я'); // кирилиця: по 2 байти
    expect(s.writes, 2);
    expect(s.bytesWritten, 5 + 4);
    expect(await s.keys('a'), ['ab']);
  });

  test('PrefsStore: запис, читання, префікс, видалення', () async {
    SharedPreferencesAsyncPlatform.instance =
        InMemorySharedPreferencesAsync.empty();
    final s = PrefsStore(SharedPreferencesAsync());
    await s.write('q/2', 'b');
    await s.write('q/1', 'a');
    await s.write('cache/x', 'c');
    expect(await s.read('q/1'), 'a');
    expect(await s.keys('q/'), ['q/1', 'q/2']);
    await s.remove('q/1');
    expect(await s.keys('q/'), ['q/2']);
    expect(await s.read('нема'), isNull);
  });
}
