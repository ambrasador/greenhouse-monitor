import 'api_client.dart';
import 'clock.dart';

/// Стан підключення пристрою до Wi-Fi, який той повідомляє по BLE.
enum WifiState { connecting, connected, authFailed, networkNotFound }

class WrongPopException implements Exception {}

class TransportException implements Exception {
  TransportException(this.message);

  final String message;
}

/// Те, що застосунку потрібно від BLE-стека. Реальна реалізація
/// (flutter_blue_plus тощо) лишається за цим інтерфейсом; машина станів
/// нижче не знає про Bluetooth.
abstract interface class ProvisioningTransport {
  Future<void> connect();

  /// Захищений сеанс: ключ виводиться з PoP. Невірний PoP → [WrongPopException].
  Future<void> openSecureSession(String pop);

  Future<void> sendCredentials(String ssid, String password);

  Future<WifiState> readWifiState();

  Future<void> disconnect();
}

abstract interface class ClaimApi {
  Future<void> claim(String deviceId);
}

enum Step {
  connecting,
  securing,
  sendingCredentials,
  waitingOnline,
  claiming,
  done,
}

enum Failure {
  connectFailed,
  wrongPop,
  wifiAuth,
  networkNotFound,
  notOnline,
  alreadyClaimed,
  claimFailed,
}

class ProvisioningResult {
  const ProvisioningResult.ok() : failure = null;
  const ProvisioningResult.failed(Failure this.failure);

  final Failure? failure;
  bool get ok => failure == null;
}

/// Діапазон Wi-Fi за частотою каналу в МГц. Пристрій, що працює лише
/// в 2,4 ГГц (це вказує його специфікація), не побачить мережі на 5 ГГц,
/// тож її варто відхилити до надсилання пароля.
enum Band { ghz2, ghz5, ghz6, unknown }

Band bandOf(int mhz) {
  if (mhz >= 2400 && mhz <= 2500) return Band.ghz2;
  if (mhz >= 4900 && mhz <= 5900) return Band.ghz5;
  if (mhz >= 5925 && mhz <= 7125) return Band.ghz6;
  return Band.unknown;
}

/// Прив’язка нового пристрою: BLE → захищений сеанс → облікові дані Wi-Fi →
/// очікування «онлайн» → claim у хмарі. На все після надсилання пароля дано
/// [timeout]; стан читається кожні [pollEvery].
class Provisioner {
  Provisioner({
    required this.transport,
    required this.api,
    required this.clock,
    required this.delay,
    this.pollEvery = const Duration(seconds: 3),
    this.timeout = const Duration(seconds: 60),
    this.onStep,
  });

  final ProvisioningTransport transport;
  final ClaimApi api;
  final Clock clock;
  final Future<void> Function(Duration) delay;
  final Duration pollEvery;
  final Duration timeout;
  final void Function(Step)? onStep;

  Future<ProvisioningResult> run({
    required String deviceId,
    required String pop,
    required String ssid,
    required String password,
  }) async {
    ProvisioningResult fail(Failure f) => ProvisioningResult.failed(f);
    try {
      onStep?.call(Step.connecting);
      await transport.connect();
      onStep?.call(Step.securing);
      await transport.openSecureSession(pop);
      onStep?.call(Step.sendingCredentials);
      await transport.sendCredentials(ssid, password);

      onStep?.call(Step.waitingOnline);
      final deadline = clock.now().add(timeout);
      while (true) {
        switch (await transport.readWifiState()) {
          case WifiState.connected:
            break;
          case WifiState.authFailed:
            return fail(Failure.wifiAuth);
          case WifiState.networkNotFound:
            return fail(Failure.networkNotFound);
          case WifiState.connecting:
            if (!clock.now().isBefore(deadline)) {
              return fail(Failure.notOnline);
            }
            await delay(pollEvery);
            continue;
        }
        break;
      }

      onStep?.call(Step.claiming);
      while (true) {
        try {
          await api.claim(deviceId);
          break;
        } on ApiException catch (e) {
          if (e.code == 'already-claimed') {
            return fail(Failure.alreadyClaimed);
          }
          final retriable =
              e.code == 'device-offline' || e.kind == FailureKind.transient;
          if (!retriable) return fail(Failure.claimFailed);
          if (!clock.now().isBefore(deadline)) {
            return fail(Failure.notOnline);
          }
          await delay(pollEvery);
        }
      }
      onStep?.call(Step.done);
      return const ProvisioningResult.ok();
    } on WrongPopException {
      return fail(Failure.wrongPop);
    } on TransportException {
      return fail(Failure.connectFailed);
    } finally {
      try {
        await transport.disconnect();
      } on Object {
        // зв’язок міг уже зникнути
      }
    }
  }
}
