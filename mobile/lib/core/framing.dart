import 'dart:typed_data';

/// Службові байти ATT у запиті Write: код операції (1) і handle атрибута (2).
const attOverhead = 3;

/// MTU за замовчуванням. Домовлений MTU залежить від телефона й пристрою,
/// тому застосунок читає його зі стека, а не припускає.
const defaultMtu = 23;

int payloadPerWrite(int mtu) => mtu - attOverhead;

/// Кадр: два байти довжини (big-endian) і корисне навантаження.
int frameSize(int payloadBytes) => 2 + payloadBytes;

/// Скільки записів у характеристику потрібно на повідомлення.
int writesNeeded(int payloadBytes, int mtu) {
  final per = payloadPerWrite(mtu);
  return (frameSize(payloadBytes) + per - 1) ~/ per;
}

class FramingError implements Exception {
  FramingError(this.message);

  final String message;

  @override
  String toString() => 'FramingError($message)';
}

/// Ріже повідомлення на записи, що вміщуються в `MTU − 3` байтів.
List<Uint8List> frameMessage(List<int> payload, {required int mtu}) {
  if (payload.length > 0xFFFF) throw FramingError('повідомлення завелике');
  final all = Uint8List(frameSize(payload.length))
    ..[0] = payload.length >> 8
    ..[1] = payload.length & 0xFF
    ..setRange(2, 2 + payload.length, payload);
  final step = payloadPerWrite(mtu);
  return [
    for (var i = 0; i < all.length; i += step)
      Uint8List.sublistView(
        all,
        i,
        i + step > all.length ? all.length : i + step,
      ),
  ];
}

/// Збирає повідомлення з шматків довільного розміру: кадр може обірватися
/// всередині заголовка, а в одному шматку може опинитися кінець одного
/// повідомлення й початок іншого.
class Reassembler {
  Reassembler({this.maxMessage = 1024});

  /// Межа довжини з заголовка: збій пристрою не змусить копити 64 КБ.
  final int maxMessage;
  final List<int> _buf = [];

  int get buffered => _buf.length;

  List<Uint8List> add(List<int> chunk) {
    _buf.addAll(chunk);
    final out = <Uint8List>[];
    while (_buf.length >= 2) {
      final len = (_buf[0] << 8) | _buf[1];
      if (len > maxMessage) {
        _buf.clear();
        throw FramingError('довжина $len більша за $maxMessage');
      }
      if (_buf.length < 2 + len) break;
      out.add(Uint8List.fromList(_buf.sublist(2, 2 + len)));
      _buf.removeRange(0, 2 + len);
    }
    return out;
  }

  void reset() => _buf.clear();
}
