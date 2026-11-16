import 'dart:async';

import 'package:firebase_messaging/firebase_messaging.dart';

import '../core/api_client.dart';
import '../core/models.dart';
import '../core/push_router.dart';
import '../core/push_tokens.dart';

PushMessage toPushMessage(RemoteMessage m) => PushMessage(
  id: m.messageId,
  title: m.notification?.title,
  body: m.notification?.body,
  // data у FCM — рядки; усе інше відкидаємо, а не приводимо
  data: {
    for (final e in m.data.entries)
      if (e.value is String) e.key: e.value as String,
  },
);

/// Єдине місце, що знає про `firebase_messaging`: розподіляє три джерела
/// подій і передає їх чистому маршрутизатору.
class FirebasePushAdapter {
  FirebasePushAdapter({
    required this.messaging,
    required this.registrar,
    required this.router,
    required this.onAction,
  });

  final FirebaseMessaging messaging;
  final TokenRegistrar registrar;
  final PushRouter router;
  final void Function(PushAction) onAction;
  final _subs = <StreamSubscription<Object?>>[];

  Future<void> start() async {
    final settings = await messaging.requestPermission();
    if (settings.authorizationStatus == AuthorizationStatus.denied) return;

    _subs
      // спершу підписка, потім register(): подія реєстрації не мине повз
      ..add(
        messaging.onRegistered.listen(
          (fid) => _ensure(PushTarget.fid(fid)),
        ),
      )
      // застосунок на екрані: сповіщення система не малює
      ..add(
        FirebaseMessaging.onMessage.listen(
          (m) => onAction(router.onReceived(toPushMessage(m))),
        ),
      )
      // дотик по сповіщенню, коли застосунок був у фоні
      ..add(
        FirebaseMessaging.onMessageOpenedApp.listen(
          (m) => onAction(router.onOpened(toPushMessage(m))),
        ),
      );
    await messaging.register();
    await _guard(registrar.refreshIfDue);

    // дотик по сповіщенню, яке запустило застосунок з нуля
    final initial = await messaging.getInitialMessage();
    if (initial != null) onAction(router.onOpened(toPushMessage(initial)));
  }

  Future<void> _ensure(PushTarget t) => _guard(() => registrar.ensure(t));

  /// Помилка мережі не повинна стати необробленою помилкою слухача:
  /// адреса вже збережена, і refreshIfDue повторить реєстрацію.
  Future<void> _guard(Future<void> Function() action) async {
    try {
      await action();
    } on ApiException {
      // повторимо при наступному запуску
    }
  }

  Future<void> stop() async {
    for (final s in _subs) {
      await s.cancel();
    }
    _subs.clear();
  }
}
