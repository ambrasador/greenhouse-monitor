// Вимірювання M1: скільки команд виконає сервер, якщо відповіді губляться.
//
//   dart run tool/m1_duplicates.dart --base URL --n 1000 --mode MODE
//
// MODE: none        — повтор без ключа ідемпотентності;
//       per-attempt — ключ створюється заново перед кожною спробою;
//       per-action  — ключ створено при постановці дії в чергу
//                     (це робить OfflineQueue із розділу 5).
// Кожну «дію користувача» повторюють до [maxAttempts] разів, доки не прийде
// відповідь. У кінці друкується один рядок JSON.
import 'dart:convert';
import 'dart:io' show stdout;

import 'package:greenhouse_mobile/core/api_client.dart';
import 'package:greenhouse_mobile/core/clock.dart';
import 'package:greenhouse_mobile/core/offline_queue.dart';
import 'package:greenhouse_mobile/core/store.dart';
import 'package:http/http.dart' as http;
import 'package:uuid/uuid.dart';

const maxAttempts = 10;

/// Рахує запити, які покинули клієнт, і ті, що не отримали відповіді.
class CountingClient extends http.BaseClient {
  CountingClient(this._inner);

  final http.Client _inner;
  int sent = 0;
  int lost = 0;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    sent++;
    try {
      return await _inner.send(request);
    } on Object {
      lost++;
      rethrow;
    }
  }
}

Future<void> main(List<String> args) async {
  final a = <String, String>{
    for (var i = 0; i + 1 < args.length; i += 2)
      args[i].substring(2): args[i + 1],
  };
  final base = Uri.parse(a['base']!);
  final n = int.parse(a['n']!);
  final mode = a['mode']!;
  const device = 'gh1-s01';
  final client = CountingClient(http.Client());
  final api = ApiClient(
    base: base,
    client: client,
    clock: ServerClock(const SystemClock()),
    timeout: const Duration(seconds: 5),
  );
  final queue = OfflineQueue(
    store: MemoryStore(),
    api: api,
    clock: const SystemClock(),
    rnd: () => 0, // паузи між спробами нам тут не потрібні
  );
  const uuid = Uuid();
  const params = {'duration_sec': 5};
  var confirmed = 0;

  for (var i = 0; i < n; i++) {
    switch (mode) {
      case 'none':
        for (var k = 0; k < maxAttempts; k++) {
          try {
            final r = await client.post(
              base.resolve('devices/$device/commands'),
              headers: {'Content-Type': 'application/json'},
              body: jsonEncode({'name': 'irrigate', 'params': params}),
            );
            if (r.statusCode == 202) {
              confirmed++;
              break;
            }
          } on Object {
            // відповіді не було: користувач (або код) натисне ще раз
          }
        }
      case 'per-attempt':
        for (var k = 0; k < maxAttempts; k++) {
          try {
            await api.sendCommand(
              device,
              'irrigate',
              params,
              idempotencyKey: uuid.v4(),
            );
            confirmed++;
            break;
          } on ApiException {
            // тимчасова відмова: нова спроба з новим ключем
          }
        }
      case 'per-action':
        final action = await queue.enqueueCommand(
          device,
          'irrigate',
          params,
        );
        for (var k = 0; k < maxAttempts && queue.pendingCount > 0; k++) {
          await queue.flush(force: true);
        }
        if (queue.pendingCount == 0) {
          confirmed++;
        } else {
          await queue.dismiss(action.id);
        }
      default:
        throw ArgumentError('невідомий режим $mode');
    }
  }
  stdout.writeln(
    jsonEncode({
      'mode': mode,
      'n': n,
      'confirmed': confirmed,
      'requestsSent': client.sent,
      'requestsLost': client.lost,
    }),
  );
}
