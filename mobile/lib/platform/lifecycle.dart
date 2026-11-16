import 'package:flutter/widgets.dart';

/// Повідомляє, що застосунок повернувся на передній план. Поки екран
/// був погашений, система могла призупинити процес разом із таймерами.
class ResumeObserver with WidgetsBindingObserver {
  ResumeObserver(this.onResumed);

  final VoidCallback onResumed;

  void attach() => WidgetsBinding.instance.addObserver(this);

  void detach() => WidgetsBinding.instance.removeObserver(this);

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) onResumed();
  }
}
