// M2: похибка годинника сервера, виміряного за заголовком Date.
//   dart run tool/m2_clock.dart --base URL --skew-ms 37300 --n 100 --gap-ms 137
// Телефон «поспішає» на skew; після кожної відповіді порівнюємо виправлений
// годинник із справжнім часом цієї машини (сервер на ній самій).
import 'dart:convert';
import 'dart:io' show stdout;

import 'package:greenhouse_mobile/core/api_client.dart';
import 'package:greenhouse_mobile/core/clock.dart';
import 'package:http/http.dart' as http;

class SkewedClock implements Clock {
  SkewedClock(this.skew);

  final Duration skew;

  @override
  DateTime now() => DateTime.now().toUtc().add(skew);
}

Future<void> main(List<String> args) async {
  final a = <String, String>{
    for (var i = 0; i + 1 < args.length; i += 2)
      args[i].substring(2): args[i + 1],
  };
  final n = int.parse(a['n'] ?? '100');
  final gap = Duration(milliseconds: int.parse(a['gap-ms'] ?? '137'));
  final skew = Duration(milliseconds: int.parse(a['skew-ms'] ?? '0'));
  final clock = ServerClock(SkewedClock(skew));
  final api = ApiClient(
    base: Uri.parse(a['base']!),
    client: http.Client(),
    clock: clock,
  );
  final errors =
      <int>[]; // мс: (годинник після виправлення) − (справжній час)
  final rtts = <int>[];
  for (var i = 0; i < n; i++) {
    final t0 = DateTime.now();
    await api.getDevice('gh1-s01');
    rtts.add(DateTime.now().difference(t0).inMicroseconds);
    errors.add(
      clock.now().difference(DateTime.now().toUtc()).inMilliseconds,
    );
    await Future<void>.delayed(gap);
  }
  final abs = errors.map((e) => e.abs()).toList()..sort();
  rtts.sort();
  stdout.writeln(
    jsonEncode({
      'n': n,
      'skewMs': skew.inMilliseconds,
      'errMinMs': errors.reduce((x, y) => x < y ? x : y),
      'errMaxMs': errors.reduce((x, y) => x > y ? x : y),
      'absMeanMs': abs.reduce((x, y) => x + y) / abs.length,
      'absP95Ms': abs[(abs.length * 0.95).floor() - 1],
      'rttMedianUs': rtts[rtts.length ~/ 2],
      'rttMaxUs': rtts.last,
    }),
  );
}
