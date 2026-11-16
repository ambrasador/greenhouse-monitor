// Спільне для інтеграційних тестів: процес стенда (Node), клієнт до нього,
// очікування умови й відкриття потоку SSE.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:greenhouse_mobile/core/api_client.dart';
import 'package:greenhouse_mobile/core/clock.dart';
import 'package:greenhouse_mobile/core/sse_client.dart';
import 'package:http/http.dart' as http;

/// Час у форматі сервера: UTC, мілісекунди, `Z`.
String iso(DateTime t) => DateTime.fromMillisecondsSinceEpoch(
  t.millisecondsSinceEpoch,
  isUtc: true,
).toIso8601String();

/// Процес стенда: сервер, мобільні кінцеві точки, імітація FCM, проксі.
class Bed {
  Bed._(this._proc, this.api, this.lossy, this.ctl);

  final Process _proc;
  final Uri api;
  final Uri lossy;
  final Uri ctl;

  static Future<Bed> start(
    String dir, [
    Map<String, Object?> options = const {},
  ]) async {
    final proc = await Process.start(
      'node',
      ['serve-mobile-bed.js'],
      workingDirectory: dir,
      environment: {'BED_OPTIONS': jsonEncode(options)},
    );
    unawaited(proc.stderr.drain<void>());
    final line = await proc.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .first
        .timeout(const Duration(seconds: 20));
    final j = jsonDecode(line) as Map<String, dynamic>;
    return Bed._(
      proc,
      Uri.parse(j['api'] as String),
      Uri.parse(j['lossy'] as String),
      Uri.parse(j['ctl'] as String),
    );
  }

  Future<Map<String, dynamic>> post(
    String path, [
    Object body = const {},
  ]) async {
    final r = await http.post(ctl.resolve(path), body: jsonEncode(body));
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> stats() async {
    final r = await http.get(ctl.resolve('/stats'));
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  Future<void> reading(
    String device,
    String metric,
    double value,
    DateTime ts,
  ) async {
    final res = await post('/reading', {
      'device': device,
      'metric': metric,
      'value': value,
      'ts': iso(ts),
    });
    expect(res['result'], isNotNull);
  }

  Future<void> stop() async {
    _proc.kill();
    await _proc.exitCode.timeout(
      const Duration(seconds: 5),
      onTimeout: () {
        _proc.kill(ProcessSignal.sigkill);
        return -1;
      },
    );
  }
}

ApiClient clientFor(Uri base, {Map<String, String> headers = const {}}) =>
    ApiClient(
      base: base,
      client: http.Client(),
      clock: ServerClock(const SystemClock()),
      defaultHeaders: headers,
      timeout: const Duration(seconds: 5),
    );

Future<T> eventually<T>(
  Future<T?> Function() probe, {
  Duration timeout = const Duration(seconds: 5),
}) async {
  final end = DateTime.now().add(timeout);
  while (true) {
    final v = await probe();
    if (v != null) return v;
    if (DateTime.now().isAfter(end)) {
      throw TimeoutException('не дочекались');
    }
    await Future<void>.delayed(const Duration(milliseconds: 25));
  }
}

/// Відкриває потік, чекає `ready` і повертає підписку з накопиченими подіями.
Future<(StreamSubscription<SseEvent>, List<SseEvent>)> open(
  SseClient sse,
) async {
  final got = <SseEvent>[];
  final ready = Completer<void>();
  final sub = sse.events().listen((e) {
    got.add(e);
    if (e.event == 'ready' && !ready.isCompleted) ready.complete();
  });
  await ready.future.timeout(const Duration(seconds: 5));
  return (sub, got);
}
