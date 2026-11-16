// M10: що відбувається з потоком SSE, коли підписку скасовують.
//   dart run tool/m10_cancel.dart --base URL --ctl URL --impl legacy|abortable
//                                 --mode cancel|slots --runs N
// legacy — SseClient.events() до виправлення (async*), abortable — з пакета.
// Потік мовчить між подіями, як у житті: екран закривають не в мить події.
//   cancel: скільки мілісекунд триває `await sub.cancel()` через 300 мс після
//           останньої події;
//   slots:  runs разів поспіль відкрити потік, через 100 мс скасувати без
//           очікування (як dispose() віджета); скільки відкрилось, якщо
//           ліміт сервера — 6 потоків на клієнта.
import 'dart:async';
import 'dart:convert';
import 'dart:io' show stdout;

import 'package:greenhouse_mobile/core/api_client.dart';
import 'package:greenhouse_mobile/core/backoff.dart';
import 'package:greenhouse_mobile/core/clock.dart' show formatTs;
import 'package:greenhouse_mobile/core/sse_client.dart';
import 'package:http/http.dart' as http;

class StatusLog extends http.BaseClient {
  StatusLog(this._inner);

  final http.Client _inner;
  final codes = <int>[];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final res = await _inner.send(request);
    codes.add(res.statusCode);
    return res;
  }
}

/// `SseClient.events()` до виправлення, без змін (крім відсутніх тут
/// токена й `Last-Event-ID`): `async*` помічає скасування лише на `yield`.
Stream<SseEvent> legacyEvents(http.Client client, Uri url) async* {
  const idleTimeout = Duration(seconds: 40);
  var attempt = 0;
  Duration? serverRetry;
  while (true) {
    try {
      final req = http.Request('GET', url)
        ..headers['Accept'] = 'text/event-stream'
        ..headers['Cache-Control'] = 'no-cache';
      final res = await client.send(req);
      if (res.statusCode != 200) {
        await res.stream.drain<void>();
        throw ApiException(status: res.statusCode, title: res.reasonPhrase);
      }
      attempt = 0;
      final parser = SseParser();
      final text = res.stream
          .transform(utf8.decoder)
          .timeout(
            idleTimeout,
            onTimeout: (sink) => sink
              ..addError(TimeoutException('потік мовчить', idleTimeout))
              ..close(),
          );
      await for (final chunk in text) {
        for (final e in parser.add(chunk)) {
          serverRetry = parser.retry ?? serverRetry;
          yield e;
        }
      }
    } on Exception {
      // обрив чи відмова сервера: повторюємо
    }
    attempt++;
    final own = backoffDelay(attempt);
    await Future<void>.delayed(
      serverRetry != null && serverRetry > own ? serverRetry : own,
    );
  }
}

Future<void> main(List<String> args) async {
  final a = <String, String>{
    for (var i = 0; i + 1 < args.length; i += 2)
      args[i].substring(2): args[i + 1],
  };
  final base = Uri.parse(a['base']!);
  final ctl = Uri.parse(a['ctl']!);
  final url = base.resolve('devices/gh1-s01/stream?metrics=temperature');
  final impl = a['impl']!;
  final mode = a['mode']!;
  final runs = int.parse(a['runs']!);
  final log = StatusLog(http.Client());
  Stream<SseEvent> open() => impl == 'legacy'
      ? legacyEvents(log, url)
      : SseClient(client: log, url: url, sleep: (_) async {}).events();

  final events = <String>[];
  Future<StreamSubscription<SseEvent>?> connect() async {
    final ready = Completer<void>();
    final sub = open().listen((e) {
      events.add(e.event);
      if (e.event == 'ready' && !ready.isCompleted) ready.complete();
    });
    try {
      await ready.future.timeout(const Duration(seconds: 1));
      return sub;
    } on TimeoutException {
      unawaited(sub.cancel());
      return null;
    }
  }

  final cancelMs = <int>[];
  var opened = 0;
  for (var i = 0; i < runs; i++) {
    final sub = await connect();
    if (sub == null) continue;
    opened++;
    if (mode == 'cancel') {
      // одна подія, щоб потік не був порожнім, і пауза: екран закривають
      // не в мить події
      final before = events.length;
      await http.post(
        ctl.resolve('/reading'),
        body: jsonEncode({
          'device': 'gh1-s01',
          'metric': 'temperature',
          'value': 20.0 + i,
          'ts': formatTs(DateTime.now().toUtc()),
        }),
      );
      while (events.length == before) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      await Future<void>.delayed(const Duration(milliseconds: 300));
      final sw = Stopwatch()..start();
      await sub.cancel();
      cancelMs.add(sw.elapsedMilliseconds);
    } else {
      await Future<void>.delayed(const Duration(milliseconds: 100));
      unawaited(sub.cancel()); // як dispose() віджета: без очікування
    }
  }
  stdout.writeln(
    jsonEncode({
      'impl': impl,
      'mode': mode,
      'runs': runs,
      'opened': opened,
      'cancelMs': cancelMs,
      'status200': log.codes.where((c) => c == 200).length,
      'status429': log.codes.where((c) => c == 429).length,
    }),
  );
}
