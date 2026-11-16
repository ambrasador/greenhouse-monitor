import 'api_client.dart';
import 'cache.dart';
import 'clock.dart';
import 'models.dart';

/// Дані для екрана разом із походженням: з кешу чи щойно з сервера, і чи
/// не вдалося їх оновити.
class Loaded<T> {
  const Loaded(
    this.value,
    this.savedAt, {
    this.fromCache = false,
    this.error,
  });

  final T value;
  final DateTime savedAt;
  final bool fromCache;
  final ApiException? error;
}

/// Читання «кеш → мережа»: екран отримує збережені дані одразу, а свіжі —
/// щойно вони прийдуть. Якщо мережі немає, кеш лишається на екрані з
/// позначкою помилки, а не замінюється порожнечею.
class DeviceRepository {
  DeviceRepository({
    required this.api,
    required this.cache,
    required this.clock,
  });

  final ApiClient api;
  final JsonCache cache;
  final Clock clock;

  Stream<Loaded<List<DeviceInfo>>> watchDevices() async* {
    List<DeviceInfo> parse(Object? json) => [
      for (final d in json! as List<dynamic>)
        DeviceInfo.fromJson(d as Map<String, dynamic>),
    ];
    final hit = await cache.get('devices');
    if (hit != null) {
      yield Loaded(parse(hit.value), hit.savedAt, fromCache: true);
    }
    try {
      final all = <DeviceInfo>[];
      String? cursor;
      do {
        final page = await api.listDevices(cursor: cursor);
        all.addAll(page.items);
        cursor = page.next;
      } while (cursor != null);
      await cache.put('devices', [for (final d in all) d.toJson()]);
      yield Loaded(all, clock.now());
    } on ApiException catch (e) {
      if (hit == null) rethrow;
      yield Loaded(
        parse(hit.value),
        hit.savedAt,
        fromCache: true,
        error: e,
      );
    }
  }

  Stream<Loaded<DeviceInfo>> watchDevice(String id) async* {
    final key = 'device/$id';
    DeviceInfo parse(Object? json) =>
        DeviceInfo.fromJson(json! as Map<String, dynamic>);
    final hit = await cache.get(key);
    if (hit != null) {
      yield Loaded(parse(hit.value), hit.savedAt, fromCache: true);
    }
    try {
      final d = await api.getDevice(id);
      await cache.put(key, d.toJson());
      yield Loaded(d, clock.now());
    } on ApiException catch (e) {
      if (hit == null) rethrow;
      yield Loaded(
        parse(hit.value),
        hit.savedAt,
        fromCache: true,
        error: e,
      );
    }
  }
}
