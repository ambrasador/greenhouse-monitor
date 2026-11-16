import 'dart:async';
import 'dart:convert';

import 'package:collection/collection.dart';
import 'package:uuid/uuid.dart';

import 'api_client.dart';
import 'backoff.dart';
import 'clock.dart';
import 'store.dart';

enum ActionKind { command, settings }

/// `pending` — чекає відправлення; решта — кінцеві стани, які користувач
/// бачить, доки не закриє їх (`dismiss`), і які не блокують чергу.
enum ActionStatus { pending, conflict, rejected, expired }

/// Скільки користувач вважає свою дію актуальною. Це властивість типу дії:
/// полив за п’ять хвилин уже не відповідає тому, що людина бачила на екрані,
/// а налаштування лишається бажаним станом і за добу.
const defaultMaxAge = {
  'irrigate': Duration(minutes: 5),
  'set_setpoint': Duration(minutes: 30),
  'settings': Duration(hours: 24),
};

class PendingAction {
  PendingAction({
    required this.id,
    required this.kind,
    required this.deviceId,
    required this.name,
    required this.params,
    required this.createdAt,
    required this.expiresAt,
    this.ifMatch,
    this.status = ActionStatus.pending,
    this.attempts = 0,
    this.error,
    this.serverCopy,
    this.serverEtag,
  });

  factory PendingAction.fromJson(Map<String, dynamic> j) => PendingAction(
    id: j['id'] as String,
    kind: ActionKind.values.byName(j['kind'] as String),
    deviceId: j['device'] as String,
    name: j['name'] as String,
    params: (j['params'] as Map<String, dynamic>).cast<String, Object?>(),
    createdAt: DateTime.parse(j['created'] as String),
    expiresAt: DateTime.parse(j['expires'] as String),
    ifMatch: j['ifMatch'] as String?,
    status: ActionStatus.values.byName(j['status'] as String),
    attempts: j['attempts'] as int,
    error: j['error'] as String?,
    serverCopy: (j['serverCopy'] as Map<String, dynamic>?)
        ?.cast<String, Object?>(),
    serverEtag: j['serverEtag'] as String?,
  );

  /// Ключ ідемпотентності. Створюється при постановці в чергу й зберігається
  /// разом із дією: кожен повтор, навіть після перезапуску, несе той самий.
  final String id;
  final ActionKind kind;
  final String deviceId;
  final String name;
  final Map<String, Object?> params;
  final DateTime createdAt;
  final DateTime expiresAt;

  /// ETag, який користувач бачив, коли правив налаштування.
  String? ifMatch;
  ActionStatus status;
  int attempts;
  String? error;

  /// Що зараз на сервері, якщо сталася колізія 412.
  Map<String, Object?>? serverCopy;
  String? serverEtag;

  Map<String, Object?> toJson() => {
    'id': id,
    'kind': kind.name,
    'device': deviceId,
    'name': name,
    'params': params,
    'created': createdAt.toIso8601String(),
    'expires': expiresAt.toIso8601String(),
    'ifMatch': ifMatch,
    'status': status.name,
    'attempts': attempts,
    'error': error,
    'serverCopy': serverCopy,
    'serverEtag': serverEtag,
  };
}

enum QueueEventType {
  enqueued,
  sent,
  retryScheduled,
  conflict,
  rejected,
  expired,
  authRequired,
  dismissed,
}

class QueueEvent {
  const QueueEvent(this.type, [this.action]);

  final QueueEventType type;
  final PendingAction? action;
}

/// Черга дій користувача, що переживає обрив зв’язку й перезапуск.
///
/// Порядок: FIFO. Тимчасова відмова (обрив, 5xx, 429) зупиняє чергу до
/// наступної спроби; остаточна відмова (4xx, 412, строк) виймає дію з
/// відправлення, але не блокує наступні. 401 ставить чергу на паузу.
class OfflineQueue {
  OfflineQueue({
    required this.store,
    required this.api,
    required this.clock,
    this.maxAge = defaultMaxAge,
    String Function()? newId,
    this.rnd,
  }) : _newId = newId ?? const Uuid().v4;

  static const _prefix = 'q/';

  final KeyValueStore store;
  final ApiClient api;
  final Clock clock;
  final Map<String, Duration> maxAge;
  final double Function()? rnd;
  final String Function() _newId;

  final List<PendingAction> _items = [];
  final Map<String, String> _keyOf = {};
  final Map<String, DateTime> _retryAt = {};
  final _events = StreamController<QueueEvent>.broadcast(sync: true);
  int _seq = 0;
  bool _paused = false;
  Future<Duration?>? _running;
  bool _rerun = false;

  Stream<QueueEvent> get events => _events.stream;
  bool get paused => _paused;
  List<PendingAction> get actions => List.unmodifiable(_items);
  int get pendingCount =>
      _items.where((a) => a.status == ActionStatus.pending).length;

  /// Чи є для пристрою дія [name], що ще не пішла на сервер. Екран за цим
  /// вимикає кнопку: другий дотик — це нова команда з новим ключем, і ключ
  /// його не зупинить.
  bool hasPending(String deviceId, String name) => _items.any(
    (a) =>
        a.deviceId == deviceId &&
        a.name == name &&
        a.status == ActionStatus.pending,
  );

  /// Через скільки черга має прокинутись сама: пауза між спробами для
  /// першої дії, що чекає, але не пізніше за її строк дії. `null` — будити
  /// нема кого: черга порожня, на паузі після 401 або дію ще не пробували.
  /// Лише перша дія, бо тимчасова відмова зупиняє весь прохід.
  Duration? get nextWake {
    if (_paused) return null;
    for (final a in _items) {
      if (a.status != ActionStatus.pending) continue;
      final due = _retryAt[a.id];
      if (due == null) return null;
      final at = due.isBefore(a.expiresAt) ? due : a.expiresAt;
      final wait = at.difference(clock.now());
      return wait.isNegative ? Duration.zero : wait;
    }
    return null;
  }

  /// Читає чергу зі сховища. Пошкоджений запис видаляється, решта живе.
  Future<void> load() async {
    _items.clear();
    for (final key in await store.keys(_prefix)) {
      try {
        final raw = await store.read(key);
        final a = PendingAction.fromJson(
          jsonDecode(raw!) as Map<String, dynamic>,
        );
        _items.add(a);
        _keyOf[a.id] = key;
        _seq = int.parse(key.substring(_prefix.length));
      } on Object {
        await store.remove(key);
      }
    }
  }

  Future<PendingAction> enqueueCommand(
    String deviceId,
    String name,
    Map<String, Object?> params,
  ) => _enqueue(ActionKind.command, deviceId, name, params);

  Future<PendingAction> enqueueSettings(
    String deviceId,
    Map<String, Object?> body, {
    required String ifMatch,
  }) => _enqueue(
    ActionKind.settings,
    deviceId,
    'settings',
    body,
    ifMatch: ifMatch,
  );

  Future<PendingAction> _enqueue(
    ActionKind kind,
    String deviceId,
    String name,
    Map<String, Object?> params, {
    String? ifMatch,
  }) async {
    final now = clock.now();
    final a = PendingAction(
      id: _newId(),
      kind: kind,
      deviceId: deviceId,
      name: name,
      params: params,
      createdAt: now,
      expiresAt: now.add(maxAge[name] ?? const Duration(minutes: 5)),
      ifMatch: ifMatch,
    );
    _items.add(a);
    _keyOf[a.id] = '$_prefix${(++_seq).toString().padLeft(10, '0')}';
    await _persist(a); // 1. спершу на диск…
    _events.add(QueueEvent(QueueEventType.enqueued, a));
    unawaited(flush()); // 2. …потім спроба відправлення у фоні
    return a;
  }

  Future<void> _persist(PendingAction a) =>
      store.write(_keyOf[a.id]!, jsonEncode(a.toJson()));

  Future<void> _drop(PendingAction a) async {
    _items.remove(a);
    _retryAt.remove(a.id);
    await store.remove(_keyOf.remove(a.id)!);
  }

  /// Закриває кінцевий стан (помилку, колізію, прострочену дію).
  Future<void> dismiss(String id) async {
    final a = _items.firstWhere((x) => x.id == id);
    await _drop(a);
    _events.add(QueueEvent(QueueEventType.dismissed, a));
  }

  /// Колізія 412: «залишити моє» повторює запис, спираючись на ETag, який
  /// сервер щойно показав; «взяти серверне» просто закриває дію.
  Future<void> resolveKeepMine(String id) async {
    final a = _items.firstWhere((x) => x.id == id);
    a
      ..ifMatch = a.serverEtag
      ..status = ActionStatus.pending
      ..attempts = 0
      ..error = null;
    await _persist(a);
    unawaited(flush(force: true));
  }

  /// Після повторного входу.
  void resume() {
    _paused = false;
    unawaited(flush(force: true));
  }

  /// Одна спроба вичерпати чергу. Повертає, через скільки викликати знову
  /// (або `null`, якщо чекати нічого). Одночасно працює один прохід.
  /// [force] скидає очікування між спробами: з’явилася мережа чи застосунок
  /// повернувся на передній план.
  Future<Duration?> flush({bool force = false}) {
    if (force) _retryAt.clear();
    final running = _running;
    if (running != null) {
      _rerun = true; // дію додали посеред проходу: потрібен ще один
      return running;
    }
    return _running = _loop();
  }

  Future<Duration?> _loop() async {
    Duration? wait;
    try {
      do {
        _rerun = false;
        wait = await _drain();
      } while (_rerun);
    } finally {
      // у тому самому кроці, що й остання перевірка _rerun: виклик flush()
      // між ними не міг би ні запустити прохід, ні потрапити в щілину
      _running = null;
    }
    return wait;
  }

  Future<Duration?> _drain() async {
    for (final a in List.of(_items)) {
      if (_paused) return null;
      if (a.status != ActionStatus.pending) continue;
      final now = clock.now();
      if (!now.isBefore(a.expiresAt)) {
        await _finish(a, ActionStatus.expired, QueueEventType.expired);
        continue;
      }
      final due = _retryAt[a.id];
      if (due != null && now.isBefore(due)) return due.difference(now);
      try {
        await _send(a);
        await _drop(a);
        _events.add(QueueEvent(QueueEventType.sent, a));
      } on ApiException catch (e) {
        final wait = await _fail(a, e);
        if (wait != null) return wait; // тимчасова відмова зупиняє чергу
        if (_paused) return null;
      }
    }
    return null;
  }

  Future<void> _send(PendingAction a) async {
    switch (a.kind) {
      case ActionKind.command:
        await api.sendCommand(
          a.deviceId,
          a.name,
          a.params,
          idempotencyKey: a.id,
        );
      case ActionKind.settings:
        await api.putSettings(a.deviceId, a.params, ifMatch: a.ifMatch!);
    }
  }

  /// Повертає затримку до наступної спроби для тимчасової відмови.
  Future<Duration?> _fail(PendingAction a, ApiException e) async {
    switch (e.kind) {
      case FailureKind.transient:
        a.attempts++;
        final own = backoffDelay(a.attempts, rnd: rnd);
        final wait = e.retryAfter != null && e.retryAfter! > own
            ? e.retryAfter!
            : own;
        _retryAt[a.id] = clock.now().add(wait);
        await _persist(a);
        _events.add(QueueEvent(QueueEventType.retryScheduled, a));
        return wait;
      case FailureKind.auth:
        _paused = true;
        _events.add(QueueEvent(QueueEventType.authRequired, a));
      case FailureKind.conflict:
        // Втрачена відповідь на PUT: наш запис дійшов, а повтор із старим
        // ETag отримав 412. Якщо сервер уже містить саме те, що ми
        // надсилали, це успіх, а не колізія.
        final current = e.extra['current'];
        if (a.kind == ActionKind.settings &&
            const DeepCollectionEquality().equals(current, a.params)) {
          await _drop(a);
          _events.add(QueueEvent(QueueEventType.sent, a));
          return null;
        }
        a.serverCopy = (current as Map<String, dynamic>?)?.cast();
        a.serverEtag = e.extra['current_etag'] as String?;
        await _finish(a, ActionStatus.conflict, QueueEventType.conflict);
      case FailureKind.rejected:
        a.error = '${e.status} ${e.code ?? e.title ?? ''}'.trim();
        await _finish(a, ActionStatus.rejected, QueueEventType.rejected);
    }
    return null;
  }

  Future<void> _finish(
    PendingAction a,
    ActionStatus s,
    QueueEventType type,
  ) async {
    a.status = s;
    await _persist(a);
    _events.add(QueueEvent(type, a));
  }
}
