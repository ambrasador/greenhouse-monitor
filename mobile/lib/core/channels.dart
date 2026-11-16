import 'api_client.dart';

enum Channel { cloud, local, ble }

enum Operation { history, liveView, command, provisioning }

/// Що доступно просто зараз: хмара (є мережа й токен), локальна Wi-Fi-мережа
/// (пристрій знайдено в тій самій підмережі), BLE (є з’єднання в межах
/// прямої видимості).
class Availability {
  const Availability({
    this.cloud = false,
    this.local = false,
    this.ble = false,
  });

  final bool cloud;
  final bool local;
  final bool ble;

  bool has(Channel c) => switch (c) {
    Channel.cloud => cloud,
    Channel.local => local,
    Channel.ble => ble,
  };
}

/// Порядок спроб для операції. Історія є лише в хмарі; живе значення краще
/// брати з локальної мережі (без шляху через інтернет); команду — туди,
/// звідки вона дійде швидше; прив’язка нового пристрою можлива лише по BLE.
const _preference = {
  Operation.history: [Channel.cloud],
  Operation.liveView: [Channel.local, Channel.cloud],
  Operation.command: [Channel.local, Channel.cloud, Channel.ble],
  Operation.provisioning: [Channel.ble],
};

/// Доступні канали у порядку переваги. Порожній список — «офлайн»: команду
/// ставимо в чергу, решту показуємо з кешу.
List<Channel> choose(Operation op, Availability a) => [
  for (final c in _preference[op]!)
    if (a.has(c)) c,
];

/// Пробує канали по черзі. Перехід на наступний канал — це повтор, тому
/// `send` має передавати той самий ключ ідемпотентності у кожному з них.
Future<T> viaChannels<T>(
  Operation op,
  Availability a,
  Map<Channel, Future<T> Function()> send,
) async {
  ApiException? last;
  for (final c in choose(op, a)) {
    final run = send[c];
    if (run == null) continue;
    try {
      return await run();
    } on ApiException catch (e) {
      if (e.kind != FailureKind.transient) rethrow;
      last = e;
    }
  }
  throw last ?? ApiException(status: 0, title: 'немає доступного каналу');
}
