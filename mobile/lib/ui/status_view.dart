import 'dart:async';

import 'package:flutter/material.dart';

import '../core/domain.dart';
import '../core/status.dart';

const _icons = {
  Level.ok: Icons.check_circle_outline,
  Level.warning: Icons.warning_amber_outlined,
  Level.critical: Icons.error_outline,
  Level.offline: Icons.help_outline,
};

/// Перебудовує екран раз на [statusTick], щоб вік даних і статус
/// перераховувалися й тоді, коли нових даних немає: потік мовчить, а
/// перебудови без події не буде (відповідник `useNow` вебдашборда).
mixin TickingState<T extends StatefulWidget> on State<T> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(statusTick, (_) => setState(() {}));
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }
}

/// Рівень статусу: значок і слово разом. Колір лише підсилює (WCAG 1.4.1:
/// кольором не передають інформацію самим).
class StatusLabel extends StatelessWidget {
  const StatusLabel(this.level, {super.key});

  final Level level;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final color = switch (level) {
      Level.ok => scheme.primary,
      Level.warning => scheme.tertiary,
      Level.critical => scheme.error,
      Level.offline => scheme.outline,
    };
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(_icons[level], size: 18, color: color),
        const SizedBox(width: 4),
        Text(levelLabels[level]!),
      ],
    );
  }
}

/// Банер про зв’язок: «Немає зв’язку. Дані станом на 12:03 (3 хв тому)».
class OfflineBanner extends StatelessWidget {
  const OfflineBanner({
    super.key,
    required this.savedAt,
    required this.now,
  });

  final DateTime savedAt;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final t = savedAt.toLocal();
    final hhmm =
        '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
    return Material(
      color: Theme.of(context).colorScheme.secondaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            const Icon(Icons.cloud_off_outlined),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                'Немає зв’язку. Дані станом на $hhmm '
                '(${ageLabel(now.difference(savedAt))})',
              ),
            ),
          ],
        ),
      ),
    );
  }
}
