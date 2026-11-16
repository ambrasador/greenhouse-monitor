import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:greenhouse_mobile/core/sse_client.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const frame =
    'retry: 4000\n\n'
    'id: 2026-11-04T12:00:01.000Z\nevent: telemetry\n'
    'data: {"device":"gh1","metric":"soil_moisture","ts":"2026-11-04T12:00:01.000Z","value":41.2}\n\n'
    'event: ready\ndata: {}\n\n'
    ': коментар\n\n'
    'event: hb\ndata: {}\n\n';

List<SseEvent> parseAll(String text, List<int> cuts) {
  final p = SseParser();
  final out = <SseEvent>[];
  var from = 0;
  for (final c in [...cuts, text.length]) {
    out.addAll(p.add(text.substring(from, c)));
    from = c;
  }
  return out;
}

void main() {
  group('SseParser', () {
    test('кадри еталонного сервера', () {
      final p = SseParser();
      final ev = p.add(frame);
      expect(ev.map((e) => e.event), ['telemetry', 'ready', 'hb']);
      expect(ev[0].id, '2026-11-04T12:00:01.000Z');
      expect(ev[1].id, '2026-11-04T12:00:01.000Z', reason: 'id «липкий»');
      expect(p.retry, const Duration(milliseconds: 4000));
      expect(jsonDecode(ev[0].data)['value'], 41.2);
    });

    test(
      'багаторядкові дані, CRLF і CR, подія без data не доставляється',
      () {
        final ev = SseParser().add(
          'data: a\r\ndata: b\r\rdata:c\r\n\r\nevent: x\n\n',
        );
        expect(ev.map((e) => [e.event, e.data]), [
          ['message', 'a\nb'],
          ['message', 'c'],
        ]);
      },
    );

    test('BOM на початку потоку, поле без двокрапки, id з NUL', () {
      final ev = SseParser().add('﻿data\nid: a\u0000b\n\ndata: z\n\n');
      expect(ev.map((e) => e.data), ['', 'z']);
      expect(ev.map((e) => e.id), [null, null]);
    });

    test(
      'результат не залежить від того, як потік нарізано (500 нарізок)',
      () {
        final rnd = Random(11);
        final want = parseAll(frame * 3, const []);
        expect(want, hasLength(9));
        for (var i = 0; i < 500; i++) {
          final cuts = {
            for (var k = 0; k < 1 + rnd.nextInt(12); k++)
              rnd.nextInt(frame.length * 3),
          }.toList()..sort();
          final got = parseAll(frame * 3, cuts);
          expect(
            got.map((e) => e.toString()),
            want.map((e) => e.toString()),
            reason: '$cuts',
          );
        }
      },
    );

    test('retry приймає лише цифри', () {
      final p = SseParser();
      p.add('retry: abc\n\n');
      expect(p.retry, isNull);
      p.add('retry: 2500\n\n');
      expect(p.retry, const Duration(milliseconds: 2500));
      p.add('retry: -1\n\nretry: 12x\n\n');
      expect(p.retry, const Duration(milliseconds: 2500));
    });

    test('CRLF розрізано між \\r і \\n', () {
      final p = SseParser();
      expect(p.add('data: a\r'), isEmpty);
      expect(p.add('\n\r'), hasLength(1));
      expect(
        p.add('\n'),
        isEmpty,
        reason: 'другий CRLF не створює порожню подію',
      );
    });
  });

  group('SseClient', () {
    http.StreamedResponse ok(Stream<List<int>> body) =>
        http.StreamedResponse(
          body,
          200,
          headers: {'content-type': 'text/event-stream; charset=utf-8'},
        );

    test(
      'обрив: перепідключення з Last-Event-ID, пауза = max(retry, джитер)',
      () async {
        final seen = <http.BaseRequest>[];
        var call = 0;
        final client = MockClient.streaming((req, _) async {
          seen.add(req);
          if (++call == 1) {
            final c = StreamController<List<int>>();
            c.add(
              utf8.encode(
                'retry: 5000\n\nid: A\nevent: telemetry\ndata: 1\n\n',
              ),
            );
            c.add(utf8.encode('id: B\nevent: telemetry\ndata: 2\n\n'));
            c.addError(http.ClientException('обрив'));
            unawaited(c.close());
            return ok(c.stream);
          }
          return ok(
            Stream.value(
              utf8.encode('id: C\nevent: telemetry\ndata: 3\n\n'),
            ),
          );
        });
        final sleeps = <Duration>[];
        final sse = SseClient(
          client: client,
          url: Uri.parse('http://bed.test/api/v1/devices/gh1/stream'),
          sleep: (d) async => sleeps.add(d),
          rnd: () => 0.5,
        );
        final got = await sse.events().take(3).toList();
        expect(got.map((e) => e.id), ['A', 'B', 'C']);
        expect(seen[0].headers['Last-Event-ID'], isNull);
        expect(seen[1].headers['Last-Event-ID'], 'B');
        expect(sleeps.first, const Duration(milliseconds: 5000));
      },
    );

    test('UTF-8 символ, розрізаний між шматками, не псується', () async {
      final bytes = utf8.encode('data: Грядка Б\n\n');
      // «Г» — байти 6 і 7 (D0 93): розріз після байта 6 ділить літеру
      final client = MockClient.streaming(
        (req, _) async => ok(
          Stream.fromIterable([bytes.sublist(0, 7), bytes.sublist(7)]),
        ),
      );
      final sse = SseClient(
        client: client,
        url: Uri.parse('http://bed.test/s'),
      );
      expect((await sse.events().first).data, 'Грядка Б');
    });

    test('потік, що мовчить, вважається мертвим', () async {
      var call = 0;
      final client = MockClient.streaming((req, _) async {
        if (++call == 1) return ok(StreamController<List<int>>().stream);
        return ok(Stream.value(utf8.encode('data: живий\n\n')));
      });
      final sse = SseClient(
        client: client,
        url: Uri.parse('http://bed.test/s'),
        idleTimeout: const Duration(milliseconds: 40),
        sleep: (_) async {},
      );
      expect((await sse.events().first).data, 'живий');
      expect(call, 2);
    });

    test(
      'скасування підписки одразу подає сигнал обриву з’єднання',
      () async {
        late http.BaseRequest seen;
        final client = MockClient.streaming((req, _) async {
          seen = req;
          return ok(StreamController<List<int>>().stream); // мовчить
        });
        final sse = SseClient(
          client: client,
          url: Uri.parse('http://bed.test/s'),
        );
        final sub = sse.events().listen((_) {});
        await pumpEventQueue();
        var aborted = false;
        unawaited(
          (seen as http.Abortable).abortTrigger!.then(
            (_) => aborted = true,
          ),
        );
        await sub.cancel();
        await pumpEventQueue();
        expect(aborted, isTrue);
      },
    );

    test('401 не повторюють: рішення за застосунком', () async {
      final client = MockClient.streaming(
        (req, _) async => http.StreamedResponse(const Stream.empty(), 401),
      );
      final sse = SseClient(
        client: client,
        url: Uri.parse('http://bed.test/s'),
      );
      await expectLater(sse.events().first, throwsA(anything));
    });
  });
}
