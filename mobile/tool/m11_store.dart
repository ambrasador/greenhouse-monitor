// M11: скільки байтів передає сховищу черга з N дій: ключ на дію проти
// єдиного списку, який переписують при кожній зміні.
//   dart run tool/m11_store.dart
// Послідовність операцій однакова: N постановок без мережі (прохід щоразу
// впирається в першу дію), потім мережа з’являється й черга спорожнюється.
import 'dart:convert';
import 'dart:io' show stdout;

import 'package:greenhouse_mobile/core/api_client.dart';
import 'package:greenhouse_mobile/core/clock.dart';
import 'package:greenhouse_mobile/core/offline_queue.dart';
import 'package:greenhouse_mobile/core/store.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// Реальна схема: кожна дія — окремий ключ. Видалення коштує довжину ключа.
class PerKeyStore implements KeyValueStore {
  final _data = <String, String>{};
  int ops = 0;
  int bytes = 0;

  @override
  Future<String?> read(String key) async => _data[key];

  @override
  Future<void> write(String key, String value) async {
    _data[key] = value;
    ops++;
    bytes += utf8.encode(key).length + utf8.encode(value).length;
  }

  @override
  Future<void> remove(String key) async {
    if (_data.remove(key) != null) {
      ops++;
      bytes += utf8.encode(key).length;
    }
  }

  @override
  Future<List<String>> keys(String prefix) async =>
      _data.keys.where((k) => k.startsWith(prefix)).toList()..sort();
}

/// Модель: усе сховище — один запис, і кожна зміна переписує його повністю.
class BlobStore implements KeyValueStore {
  final _data = <String, String>{};
  int _size = 0;
  int ops = 0;
  int bytes = 0;

  int _cost(String k, String v) =>
      utf8.encode(k).length + utf8.encode(v).length;

  @override
  Future<String?> read(String key) async => _data[key];

  @override
  Future<void> write(String key, String value) async {
    final old = _data[key];
    if (old != null) _size -= _cost(key, old);
    _data[key] = value;
    _size += _cost(key, value);
    ops++;
    bytes += _size;
  }

  @override
  Future<void> remove(String key) async {
    final old = _data.remove(key);
    if (old == null) return;
    _size -= _cost(key, old);
    ops++;
    bytes += _size;
  }

  @override
  Future<List<String>> keys(String prefix) async =>
      _data.keys.where((k) => k.startsWith(prefix)).toList()..sort();
}

Future<int> scenario(KeyValueStore store, int n) async {
  var online = false;
  // Фіксований час із ненульовими мікросекундами: мітки часу в записах дії
  // мають однакову довжину в кожному прогоні, і байти відтворюються точно
  final clock = ManualClock(DateTime.utc(2026, 11, 5, 12, 0, 0, 123, 456));
  final client = MockClient((req) async {
    if (!online) throw http.ClientException('немає мережі');
    return http.Response(
      jsonEncode({
        'id': 'c',
        'device_id': 'gh1-s01',
        'name': 'irrigate',
        'status': 'pending',
      }),
      202,
      headers: {'content-type': 'application/json'},
    );
  });
  final queue = OfflineQueue(
    store: store,
    api: ApiClient(
      base: Uri.parse('http://bed.test/api/v1/'),
      client: client,
      clock: ServerClock(clock),
    ),
    clock: clock,
    rnd: () => 0,
  );
  for (var i = 0; i < n; i++) {
    await queue.enqueueCommand('gh1-s01', 'irrigate', {'duration_sec': 5});
  }
  await queue.flush(force: true);
  final queued = (await store.keys('q/')).length;
  online = true;
  for (var k = 0; k < n + 5 && queue.pendingCount > 0; k++) {
    await queue.flush(force: true);
  }
  if (queue.pendingCount != 0) throw StateError('черга не спорожніла');
  return queued;
}

Future<void> main() async {
  final rows = <Map<String, Object?>>[];
  for (final n in [10, 100, 1000]) {
    final perKey = PerKeyStore();
    final blob = BlobStore();
    final queued = await scenario(perKey, n);
    await scenario(blob, n);
    rows.add({
      'n': n,
      'queuedBeforeOnline': queued,
      'perKey': {'ops': perKey.ops, 'bytes': perKey.bytes},
      'blob': {'ops': blob.ops, 'bytes': blob.bytes},
      'ratio': double.parse((blob.bytes / perKey.bytes).toStringAsFixed(1)),
    });
  }
  stdout.writeln(jsonEncode(rows));
}
