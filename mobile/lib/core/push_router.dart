import 'clock.dart';

/// Повідомлення FCM без залежності від плагіна. Значення `data` у FCM —
/// лише рядки, тому числа й часи розбираються тут, а не вгадуються.
class PushMessage {
  const PushMessage({this.id, this.title, this.body, this.data = const {}});

  final String? id;
  final String? title;
  final String? body;
  final Map<String, String> data;
}

sealed class PushAction {
  const PushAction();
}

/// Застосунок на передньому плані: система сповіщення не показує,
/// банер малює сам застосунок.
class ShowBanner extends PushAction {
  const ShowBanner(this.deviceId, this.text);

  final String deviceId;
  final String text;
}

/// Користувач торкнувся сповіщення.
class OpenDevice extends PushAction {
  const OpenDevice(this.deviceId, this.metric);

  final String deviceId;
  final String? metric;

  /// Маршрут застосунку; `metric` потрапляє у запит, а не в шлях.
  String get route => metric == null
      ? '/devices/$deviceId'
      : '/devices/$deviceId?metric=$metric';
}

class Ignore extends PushAction {
  const Ignore(this.reason);

  final String reason;
}

final _safeId = RegExp(r'^[A-Za-z0-9_-]{1,32}$');

/// Ідентифікатор, який можна вставити в маршрут чи запит: літери, цифри,
/// `_` і `-`, до 32 знаків. Користується й маршрутизатор push, і обробник
/// маршрутів застосунку: рядок маршруту теж не можна вважати довіреним.
bool isSafeId(String value) => _safeId.hasMatch(value);

/// Вибір дії за повідомленням. Дані push — недовірений вхід: ідентифікатори
/// проходять ту саму перевірку, що й на сервері, перш ніж стати частиною
/// маршруту.
class PushRouter {
  PushRouter({
    required this.clock,
    this.maxBannerAge = const Duration(minutes: 15),
    this.remember = 200,
  });

  final Clock clock;
  final Duration maxBannerAge;
  final int remember;
  final _received = <String>{};
  final _opened = <String>{};

  bool _seen(Set<String> set, String? id) {
    if (id == null) return false;
    if (!set.add(id)) return true;
    if (set.length > remember) set.remove(set.first);
    return false;
  }

  PushAction onReceived(PushMessage m) {
    final device = m.data['device'];
    if (device == null || !_safeId.hasMatch(device)) {
      return const Ignore('немає пристрою');
    }
    if (_seen(_received, m.id)) return const Ignore('дубль');
    final ts = DateTime.tryParse(m.data['ts'] ?? '');
    if (ts != null && clock.now().difference(ts) > maxBannerAge) {
      return const Ignore('застаріле');
    }
    final text = m.body ?? m.title ?? 'Нова подія пристрою $device';
    return ShowBanner(device, text);
  }

  PushAction onOpened(PushMessage m) {
    final device = m.data['device'];
    if (device == null || !_safeId.hasMatch(device)) {
      return const Ignore('немає пристрою');
    }
    if (_seen(_opened, m.id)) return const Ignore('дубль');
    final metric = m.data['metric'];
    return OpenDevice(
      device,
      metric != null && _safeId.hasMatch(metric) ? metric : null,
    );
  }
}
