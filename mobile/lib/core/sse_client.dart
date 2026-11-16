import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'api_client.dart';
import 'backoff.dart';

class SseEvent {
  const SseEvent(this.event, this.data, this.id);

  final String event;
  final String data;

  /// Останній `id`, оголошений потоком на момент події (за специфікацією
  /// WHATWG він «липкий»: події без власного `id` успадковують попередній).
  final String? id;

  @override
  String toString() => 'SseEvent($event, $data, $id)';
}

/// Розбір `text/event-stream` за правилами WHATWG HTML §9.2. Приймає текст
/// шматками довільного розміру: рядок може обірватися посеред слова, а
/// CRLF — між `\r` і `\n`.
class SseParser {
  final _line = StringBuffer();
  final _data = StringBuffer();
  String _event = '';
  bool _hasData = false;
  bool _afterCr = false;
  bool _start = true;

  String? lastEventId;

  /// Пауза перед перепідключенням, яку оголосив сервер (`retry:`).
  Duration? retry;

  List<SseEvent> add(String chunk) {
    final out = <SseEvent>[];
    var text = chunk;
    if (_start && text.isNotEmpty) {
      _start = false;
      if (text.startsWith('\uFEFF')) text = text.substring(1);
    }
    for (final c in text.split('')) {
      if (c == '\n' && _afterCr) {
        _afterCr = false; // друга половина CRLF
      } else if (c == '\n' || c == '\r') {
        _afterCr = c == '\r';
        final e = _endOfLine();
        if (e != null) out.add(e);
      } else {
        _afterCr = false;
        _line.write(c);
      }
    }
    return out;
  }

  SseEvent? _endOfLine() {
    final line = _line.toString();
    _line.clear();
    if (line.isEmpty) return _dispatch();
    if (line.startsWith(':')) return null; // коментар
    final colon = line.indexOf(':');
    final field = colon < 0 ? line : line.substring(0, colon);
    var value = colon < 0 ? '' : line.substring(colon + 1);
    if (value.startsWith(' ')) value = value.substring(1);
    switch (field) {
      case 'event':
        _event = value;
      case 'data':
        _data
          ..write(value)
          ..write('\n');
        _hasData = true;
      case 'id':
        if (!value.contains('\u0000')) lastEventId = value;
      case 'retry':
        if (RegExp(r'^\d+$').hasMatch(value)) {
          retry = Duration(milliseconds: int.parse(value));
        }
    }
    return null;
  }

  SseEvent? _dispatch() {
    final had = _hasData;
    var data = _data.toString();
    final name = _event.isEmpty ? 'message' : _event;
    _data.clear();
    _event = '';
    _hasData = false;
    if (!had) return null;
    if (data.endsWith('\n')) data = data.substring(0, data.length - 1);
    return SseEvent(name, data, lastEventId);
  }
}

/// Потік подій SSE з перепідключенням. Після обриву клієнт чекає
/// `max(retry, повний джитер)` і повертається із `Last-Event-ID`; сервер
/// повторює пропущене. Потік, що мовчить довше за [idleTimeout]
/// (heartbeat сервера — раз на 15 с), вважається мертвим: мобільна мережа
/// вміє обривати TCP без жодного FIN.
class SseClient {
  SseClient({
    required this.client,
    required this.url,
    this.token,
    this.renew,
    this.idleTimeout = const Duration(seconds: 40),
    Future<void> Function(Duration)? sleep,
    this.rnd,
  }) : _sleep = sleep ?? ((d) => Future<void>.delayed(d));

  final http.Client client;
  final Uri url;
  final TokenProvider? token;

  /// Обмін токена після 401; без нього відмова одразу йде додатку.
  final TokenRenewer? renew;
  final Duration idleTimeout;
  final double Function()? rnd;
  final Future<void> Function(Duration) _sleep;

  String? _lastId;

  /// Останній `id`, який бачив клієнт; за ним сервер відновлює потік.
  String? get lastEventId => _lastId;

  /// Забути позицію: після `reset` повторювати вже нічого.
  void forgetPosition() => _lastId = null;

  /// Потік подій. Скасування підписки обриває з’єднання одразу: `async*`
  /// помічає скасування лише на наступному `yield`, а це наступний
  /// heartbeat, до 15 с, увесь цей час сокет лишається відкритим.
  Stream<SseEvent> events() {
    final stop = Completer<void>();
    late final StreamController<SseEvent> out;
    out = StreamController<SseEvent>(
      onListen: () => unawaited(_run(out, stop)),
      onCancel: () {
        if (!stop.isCompleted) stop.complete();
      },
    );
    return out.stream;
  }

  /// Одне з’єднання: запит із `Last-Event-ID`, перевірка статусу й текст
  /// потоку, у якому тиша довша за [idleTimeout] стає помилкою. Запит
  /// обривається, щойно спрацює [abort].
  Future<Stream<String>> _connect(Future<void> abort) async {
    // Заголовок Authorization мобільний клієнт задає сам, тож квиток
    // ?ticket=, потрібний браузерному EventSource, йому ні до чого
    late http.StreamedResponse res;
    for (var attempt = 0; ; attempt++) {
      final req = http.AbortableRequest('GET', url, abortTrigger: abort)
        ..headers['Accept'] = 'text/event-stream'
        ..headers['Cache-Control'] = 'no-cache';
      final bearer = await token?.call();
      if (bearer != null) req.headers['Authorization'] = 'Bearer $bearer';
      if (_lastId != null) req.headers['Last-Event-ID'] = _lastId!;
      res = await client.send(req);
      if (res.statusCode != 401) break;
      await res.stream.drain<void>();
      if (attempt > 0 || bearer == null || renew == null) {
        throw ApiException(status: 401, title: 'потрібен вхід');
      }
      await renew!(bearer); // SessionExpired піде додатку як auth-помилка
    }
    if (res.statusCode != 200) {
      await res.stream.drain<void>();
      final wait = int.tryParse(res.headers['retry-after'] ?? '');
      throw ApiException(
        status: res.statusCode,
        title: res.reasonPhrase,
        retryAfter: wait == null ? null : Duration(seconds: wait),
      );
    }
    return res.stream
        .transform(utf8.decoder)
        .timeout(
          idleTimeout,
          onTimeout: (sink) => sink
            ..addError(TimeoutException('потік мовчить', idleTimeout))
            ..close(),
        );
  }

  Future<void> _run(
    StreamController<SseEvent> out,
    Completer<void> stop,
  ) async {
    var attempt = 0;
    Duration? serverRetry;
    while (!stop.isCompleted) {
      final drop = Completer<void>(); // обрив саме цієї спроби
      try {
        final text = await _connect(Future.any([stop.future, drop.future]));
        attempt = 0;
        final parser = SseParser()..lastEventId = _lastId;
        await for (final chunk in text) {
          for (final e in parser.add(chunk)) {
            _lastId = parser.lastEventId;
            serverRetry = parser.retry ?? serverRetry;
            if (!stop.isCompleted) out.add(e);
          }
        }
      } on ApiException catch (e) {
        if (e.kind == FailureKind.auth) {
          // новий токен — справа додатка
          out.addError(e);
          await out.close();
          return;
        }
        serverRetry = e.retryAfter ?? serverRetry;
      } on Exception {
        // обрив, тайм-аут, скасування: далі вирішує stop
      } finally {
        if (!drop.isCompleted) drop.complete();
      }
      if (stop.isCompleted) return;
      attempt++;
      final own = backoffDelay(attempt, rnd: rnd);
      await Future.any([
        _sleep(
          serverRetry != null && serverRetry > own ? serverRetry : own,
        ),
        stop.future,
      ]);
    }
  }
}
