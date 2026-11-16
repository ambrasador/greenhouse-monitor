import 'dart:convert';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:greenhouse_mobile/core/framing.dart';

void main() {
  test('арифметика записів: MTU 23 → 20 байтів на запис', () {
    expect(payloadPerWrite(23), 20);
    expect(payloadPerWrite(185), 182);
    expect(payloadPerWrite(517), 514);
    // 300 байтів + 2 байти довжини
    expect(writesNeeded(300, 23), 16);
    expect(writesNeeded(300, 185), 2);
    expect(writesNeeded(300, 517), 1);
    expect(
      writesNeeded(18, 23),
      1,
      reason: '2 + 18 = 20 — рівно один запис',
    );
    expect(writesNeeded(19, 23), 2);
  });

  test('frameMessage дає стільки записів, скільки передбачає формула', () {
    final rnd = Random(3);
    for (final mtu in [23, 100, 185, 247, 517]) {
      for (var n = 0; n < 600; n += 7 + rnd.nextInt(5)) {
        final chunks = frameMessage(List.filled(n, 1), mtu: mtu);
        expect(
          chunks.length,
          writesNeeded(n, mtu),
          reason: 'n=$n mtu=$mtu',
        );
        expect(
          chunks.every((c) => c.length <= payloadPerWrite(mtu)),
          isTrue,
        );
      }
    }
  });

  test('повідомлення збираються з довільної нарізки (2000 спроб)', () {
    final rnd = Random(5);
    for (var trial = 0; trial < 2000; trial++) {
      final msgs = [
        for (var i = 0; i < 1 + rnd.nextInt(4); i++)
          utf8.encode(
            '{"ssid":"Тепличка-${rnd.nextInt(99)}","pw":"${'x' * rnd.nextInt(80)}"}',
          ),
      ];
      final wire = [
        for (final m in msgs) ...frameMessage(m, mtu: 23).expand((c) => c),
      ];
      // нарізаємо потік байтів зовсім інакше, ніж було записано
      final r = Reassembler();
      final got = <List<int>>[];
      var i = 0;
      while (i < wire.length) {
        final take = 1 + rnd.nextInt(30);
        got.addAll(r.add(wire.sublist(i, min(i + take, wire.length))));
        i += take;
      }
      expect(got, msgs, reason: 'trial=$trial');
      expect(r.buffered, 0);
    }
  });

  test('заголовок, розрізаний навпіл, і порожнє повідомлення', () {
    final r = Reassembler();
    expect(r.add([0]), isEmpty);
    expect(r.add([0]), [
      <int>[],
    ], reason: 'довжина 0 → порожнє повідомлення');
    expect(r.add([0, 1]), isEmpty);
    expect(r.add([42]), [
      [42],
    ]);
  });

  test('завелика довжина в заголовку відхиляється й скидає буфер', () {
    final r = Reassembler(maxMessage: 100);
    expect(
      () => r.add([0xFF, 0xFF, 1, 2, 3]),
      throwsA(isA<FramingError>()),
    );
    expect(r.buffered, 0);
    expect(r.add([0, 1, 7]), [
      [7],
    ], reason: 'після скидання приймач працює');
  });
}
