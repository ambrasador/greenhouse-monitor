import 'package:flutter/material.dart';

import '../core/clock.dart';
import '../core/domain.dart';
import '../core/models.dart';
import '../core/repository.dart';
import '../core/status.dart';
import 'status_view.dart';

/// Список пристроїв: показує кеш одразу й оновлює його з мережі.
class DeviceListScreen extends StatefulWidget {
  const DeviceListScreen({
    super.key,
    required this.repo,
    required this.clock,
    required this.onOpen,
  });

  final DeviceRepository repo;
  final Clock clock;
  final void Function(DeviceInfo) onOpen;

  @override
  State<DeviceListScreen> createState() => _DeviceListScreenState();
}

class _DeviceListScreenState extends State<DeviceListScreen>
    with TickingState<DeviceListScreen> {
  // Потік створюється один раз. Якби `watchDevices()` стояв у build(),
  // кожне перемальовування починало б запит спочатку.
  late Stream<Loaded<List<DeviceInfo>>> _stream = widget.repo
      .watchDevices();

  void _refresh() => setState(() => _stream = widget.repo.watchDevices());

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Теплиця')),
      body: StreamBuilder<Loaded<List<DeviceInfo>>>(
        stream: _stream,
        builder: (context, snap) {
          final loaded = snap.data;
          if (loaded != null) return _content(loaded, snap.connectionState);
          if (snap.hasError) return _failure();
          return const Center(child: CircularProgressIndicator());
        },
      ),
    );
  }

  /// Ні кешу, ні мережі: повідомлення й єдина дія.
  Widget _failure() => Center(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Text('Не вдалося завантажити пристрої'),
        const SizedBox(height: 8),
        FilledButton(onPressed: _refresh, child: const Text('Повторити')),
      ],
    ),
  );

  Widget _content(Loaded<List<DeviceInfo>> loaded, ConnectionState state) {
    final now = widget.clock.now();
    return Column(
      children: [
        if (loaded.error != null)
          OfflineBanner(savedAt: loaded.savedAt, now: now)
        else if (loaded.fromCache && state != ConnectionState.done)
          const LinearProgressIndicator(),
        Expanded(
          child: RefreshIndicator(
            onRefresh: () async => _refresh(),
            child: ListView(
              children: [for (final d in loaded.value) _row(d, now)],
            ),
          ),
        ),
      ],
    );
  }

  Widget _row(DeviceInfo d, DateTime now) {
    final fresh = isFresh(d.lastSeen, now: now, periodSec: devicePeriodSec);
    final level = fresh ? Level.ok : Level.offline;
    return ListTile(
      key: ValueKey(d.id),
      title: Text(d.name),
      subtitle: Text(
        d.lastSeen == null
            ? d.zone
            : '${d.zone} · ${ageLabel(now.difference(d.lastSeen!))}',
      ),
      trailing: StatusLabel(level),
      onTap: () => widget.onOpen(d),
    );
  }
}
