// M6: скільки записів у характеристику BLE потрібно на повідомлення.
//   dart run tool/m6_ble.dart
// Кожен кадр ще й збирається назад Reassembler-ом: розбіжність ламає прогін.
import 'dart:convert';
import 'dart:io' show stdout;
import 'dart:typed_data';

import 'package:greenhouse_mobile/core/framing.dart';

void main() {
  final rows = <Map<String, Object?>>[];
  for (final payload in [64, 300, 1024]) {
    for (final mtu in [23, 185, 517]) {
      final bytes = Uint8List.fromList([
        for (var i = 0; i < payload; i++) i % 251,
      ]);
      final chunks = frameMessage(bytes, mtu: mtu);
      final back = Reassembler().add([for (final c in chunks) ...c]);
      if (back.length != 1 || !_same(back.single, bytes)) {
        throw StateError('кадри не збираються: $payload B, MTU $mtu');
      }
      if (chunks.length != writesNeeded(payload, mtu)) {
        throw StateError('writesNeeded розходиться з frameMessage');
      }
      rows.add({
        'payload': payload,
        'mtu': mtu,
        'perWrite': payloadPerWrite(mtu),
        'writes': chunks.length,
        'lastBytes': chunks.last.length,
      });
    }
  }
  stdout.writeln(jsonEncode(rows));
}

bool _same(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}
