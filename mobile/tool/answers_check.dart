// Перевірка відповідей до питань розділу 5, які можна взяти з коду еталона:
// нарізка й складання кадрів (питання 3) і моменти повторів черги (питання 9).
//   dart run tool/answers_check.dart
import 'dart:convert';
import 'dart:io' show stdout;

import 'package:greenhouse_mobile/core/api_client.dart';
import 'package:greenhouse_mobile/core/clock.dart';
import 'package:greenhouse_mobile/core/framing.dart';
import 'package:greenhouse_mobile/core/offline_queue.dart';
import 'package:greenhouse_mobile/core/store.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

String hex(List<int> b) =>
    b.map((x) => x.toRadixString(16).padLeft(2, '0')).join(' ');

Future<void> main() async {
  stdout.writeln('--- нарізка: повідомлення 500 Б');
  for (final mtu in [23, 185, 517]) {
    final w = frameMessage(List.filled(500, 0x41), mtu: mtu);
    stdout.writeln(
      'MTU $mtu: записів ${w.length} (формула ${writesNeeded(500, mtu)}), '
      'останній ${w.last.length} Б, час ${w.length * 30} мс',
    );
  }

  stdout.writeln('--- складання кадрів');
  final r = Reassembler();
  final chunks = <List<int>>[
    [0x00],
    [0x02, 0x41],
    [0x42, 0x00, 0x03, 0x58],
    [0x59, 0x5A],
  ];
  for (final c in chunks) {
    final out = r.add(c);
    stdout.writeln(
      'шматок ${hex(c)} -> ${out.map(utf8.decode).toList()}, '
      'у буфері ${r.buffered} Б',
    );
  }
  try {
    Reassembler().add([0x04, 0x01]);
  } on FramingError catch (e) {
    stdout.writeln('кадр 04 01: $e');
  }
  stdout.writeln('0x0401 = ${0x0401}');

  stdout.writeln('--- повтори черги: irrigate (строк 5 хв) відповідає 500');
  for (final rnd in [1.0, 0.5]) {
    final t0 = DateTime.utc(2026, 11, 4, 12);
    final clock = ManualClock(t0);
    final tries = <int>[];
    final queue = OfflineQueue(
      store: MemoryStore(),
      api: ApiClient(
        base: Uri.parse('http://bed.test/api/v1/'),
        client: MockClient((req) async {
          final body = jsonDecode(req.body) as Map<String, dynamic>;
          if (body['name'] == 'irrigate') {
            tries.add(clock.now().difference(t0).inMilliseconds);
            return http.Response(
              '{"title":"збій"}',
              500,
              headers: {'content-type': 'application/json'},
            );
          }
          tries.add(-clock.now().difference(t0).inMilliseconds); // уставка
          return http.Response(
            jsonEncode({
              'id': 'c2',
              'device_id': 'gh1',
              'name': 'set_setpoint',
              'status': 'pending',
            }),
            202,
            headers: {'content-type': 'application/json'},
          );
        }),
        clock: ServerClock(clock),
      ),
      clock: clock,
      newId: () =>
          'k${tries.length}-${DateTime.now().microsecondsSinceEpoch}',
      rnd: () => rnd,
    );
    await queue.enqueueCommand('gh1', 'irrigate', {'duration_sec': 5});
    await queue.enqueueCommand('gh1', 'set_setpoint', {
      'metric': 'humidity',
      'value': 60,
    });
    await queue.flush();
    var guard = 0;
    while (queue.actions.isNotEmpty && guard++ < 200) {
      final w = queue.nextWake;
      if (w == null) break;
      clock.advance(w);
      await queue.flush();
    }
    final irr = tries.where((t) => t >= 0).map((t) => t / 1000).toList();
    final set = tries.where((t) => t < 0).map((t) => -t / 1000).toList();
    stdout.writeln('rnd=$rnd: спроб поливу ${irr.length}: $irr');
    stdout.writeln(
      '  уставка відправлена на $set с; дії в черзі: '
      '${queue.actions.map((a) => a.status.name).toList()}',
    );
  }
}
