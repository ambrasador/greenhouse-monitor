import 'dart:async';

import 'offline_queue.dart';

typedef TimerFactory = Timer Function(Duration after, void Function() run);

/// Будить чергу: при запуску, коли вона просить зачекати, і коли застосунок
/// повернувся на екран. Сама черга таймерів не має, тому її перевіряють без
/// пауз; усі таймери — тут, і тест підставляє власну фабрику.
///
/// Поки процес призупинено системою, таймер не спрацює. Усе, що тоді
/// накопичилось, піде при поверненні на екран ([onResumed]), якщо строк
/// дії не минув.
class QueueDriver {
  QueueDriver(this.queue, {TimerFactory? timer})
    : _timer = timer ?? Timer.new;

  final OfflineQueue queue;
  final TimerFactory _timer;
  StreamSubscription<QueueEvent>? _sub;
  Timer? _next;

  /// Запускає стеження й одразу пробує відправити дії з минулого сеансу.
  void start() {
    _sub ??= queue.events.listen((_) => _arm());
    _wake(force: true);
  }

  /// Застосунок на передньому плані: паузи між спробами скасовано, бо
  /// мережа могла з’явитися, поки процес спав.
  void onResumed() => _wake(force: true);

  void stop() {
    _sub?.cancel();
    _sub = null;
    _next?.cancel();
    _next = null;
  }

  void _wake({required bool force}) {
    unawaited(queue.flush(force: force).whenComplete(_arm));
  }

  /// Перераховує таймер за станом черги: подія могла змінити паузу, а
  /// прохід, що закінчився, — зняти її.
  void _arm() {
    if (_sub == null) return; // після stop() нових таймерів не буде
    _next?.cancel();
    final wait = queue.nextWake;
    _next = wait == null ? null : _timer(wait, () => _wake(force: false));
  }
}
