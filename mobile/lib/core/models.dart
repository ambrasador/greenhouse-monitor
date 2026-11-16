import 'merge.dart';

DateTime _ts(Object? s) => DateTime.parse(s! as String).toUtc();

/// Останнє значення метрики пристрою (поле `latest` у `GET /devices/{id}`).
class Latest {
  const Latest(this.metric, this.ts, this.value, [this.unit]);

  factory Latest.fromJson(Map<String, dynamic> j) => Latest(
    j['metric'] as String,
    _ts(j['ts']),
    (j['value'] as num).toDouble(),
    j['unit'] as String?,
  );

  final String metric;
  final DateTime ts;
  final double value;
  final String? unit;

  Map<String, Object?> toJson() => {
    'metric': metric,
    'ts': ts.toIso8601String(),
    'value': value,
    'unit': unit,
  };
}

class DeviceInfo {
  const DeviceInfo({
    required this.id,
    required this.name,
    required this.zone,
    this.lastSeen,
    this.latest = const [],
  });

  factory DeviceInfo.fromJson(Map<String, dynamic> j) => DeviceInfo(
    id: j['id'] as String,
    name: j['name'] as String,
    zone: j['zone'] as String,
    lastSeen: j['last_seen'] == null ? null : _ts(j['last_seen']),
    latest: [
      for (final l in (j['latest'] as List<dynamic>? ?? const []))
        Latest.fromJson(l as Map<String, dynamic>),
    ],
  );

  final String id;
  final String name;
  final String zone;
  final DateTime? lastSeen;
  final List<Latest> latest;

  Map<String, Object?> toJson() => {
    'id': id,
    'name': name,
    'zone': zone,
    'last_seen': lastSeen?.toIso8601String(),
    'latest': [for (final l in latest) l.toJson()],
  };
}

/// Сторінка списку: елементи й курсор наступної сторінки (або `null`).
class Listing<T> {
  const Listing(this.items, this.next);

  final List<T> items;
  final String? next;
}

enum CommandStatus { pending, sent, acked, failed, expired }

class CommandRecord {
  const CommandRecord({
    required this.id,
    required this.deviceId,
    required this.name,
    required this.status,
  });

  factory CommandRecord.fromJson(Map<String, dynamic> j) => CommandRecord(
    id: j['id'] as String,
    deviceId: j['device_id'] as String,
    name: j['name'] as String,
    status: CommandStatus.values.byName(j['status'] as String),
  );

  final String id;
  final String deviceId;
  final String name;
  final CommandStatus status;
}

/// Налаштування пристрою разом із ETag, на який спирається `If-Match`.
class SettingsDoc {
  const SettingsDoc(this.body, this.etag);

  final Map<String, Object?> body;
  final String etag;
}

/// Ряд телеметрії однієї метрики: точки й курсор наступної сторінки.
class TelemetryPage {
  const TelemetryPage(this.points, this.next);

  final List<Point> points;
  final String? next;
}

/// Вид адреси push. SDK `firebase_messaging` до 16-ї версії видає
/// реєстраційний токен (`getToken`), з 17-ї — Firebase Installation ID
/// (`register` і `onRegistered`). HTTP v1 приймає їх у різних полях.
enum PushKind { token, fid }

class PushTarget {
  const PushTarget(this.kind, this.id);

  const PushTarget.token(String id) : this(PushKind.token, id);
  const PushTarget.fid(String id) : this(PushKind.fid, id);

  final PushKind kind;
  final String id;

  @override
  bool operator ==(Object other) =>
      other is PushTarget && other.kind == kind && other.id == id;

  @override
  int get hashCode => Object.hash(kind, id);

  @override
  String toString() => 'PushTarget(${kind.name}, $id)';
}
