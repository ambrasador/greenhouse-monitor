import 'package:flutter_test/flutter_test.dart';
import 'package:greenhouse_mobile/core/api_client.dart';
import 'package:greenhouse_mobile/core/clock.dart';
import 'package:greenhouse_mobile/core/provisioning.dart';

class FakeTransport implements ProvisioningTransport {
  FakeTransport(
    this.states, {
    this.wrongPop = false,
    this.failConnect = false,
  });

  final List<WifiState>
  states; // що відповідає пристрій на кожне опитування
  final bool wrongPop;
  final bool failConnect;
  final log = <String>[];
  var polls = 0;
  String? sentPassword;

  @override
  Future<void> connect() async {
    log.add('connect');
    if (failConnect) throw TransportException('GATT 133');
  }

  @override
  Future<void> openSecureSession(String pop) async {
    log.add('secure:$pop');
    if (wrongPop) throw WrongPopException();
  }

  @override
  Future<void> sendCredentials(String ssid, String password) async {
    log.add('creds:$ssid');
    sentPassword = password;
  }

  @override
  Future<WifiState> readWifiState() async {
    polls++;
    return states.length > polls - 1 ? states[polls - 1] : states.last;
  }

  @override
  Future<void> disconnect() async => log.add('disconnect');
}

class FakeClaim implements ClaimApi {
  FakeClaim(this.script);

  final List<ApiException?> script; // null — успіх
  var calls = 0;

  @override
  Future<void> claim(String deviceId) async {
    final step = script.length > calls ? script[calls] : script.last;
    calls++;
    if (step != null) throw step;
  }
}

ApiException conflict(String code) => ApiException(status: 409, code: code);

void main() {
  late ManualClock clock;
  late List<Step> steps;
  late List<Duration> sleeps;

  Provisioner make(FakeTransport t, FakeClaim c) => Provisioner(
    transport: t,
    api: c,
    clock: clock,
    delay: (d) async {
      sleeps.add(d);
      clock.advance(d);
    },
    onStep: steps.add,
  );

  Future<ProvisioningResult> run(Provisioner p) => p.run(
    deviceId: 'gh1',
    pop: 'abcd1234',
    ssid: 'Home',
    password: 'secret',
  );

  setUp(() {
    clock = ManualClock(DateTime.utc(2026, 11, 4, 12));
    steps = [];
    sleeps = [];
  });

  test(
    'успіх: кроки по порядку, опитування кожні 3 с, відключення в кінці',
    () async {
      final t = FakeTransport([
        WifiState.connecting,
        WifiState.connecting,
        WifiState.connected,
      ]);
      final r = await run(make(t, FakeClaim([null])));
      expect(r.ok, isTrue);
      expect(steps, [
        Step.connecting,
        Step.securing,
        Step.sendingCredentials,
        Step.waitingOnline,
        Step.claiming,
        Step.done,
      ]);
      expect(sleeps, [
        const Duration(seconds: 3),
        const Duration(seconds: 3),
      ]);
      expect(t.log.last, 'disconnect');
    },
  );

  test('невірний PoP: пароль Wi-Fi не надсилається', () async {
    final t = FakeTransport([WifiState.connected], wrongPop: true);
    final r = await run(make(t, FakeClaim([null])));
    expect(r.failure, Failure.wrongPop);
    expect(t.sentPassword, isNull);
    expect(t.log.last, 'disconnect');
  });

  test('не вдалося підключитися по BLE', () async {
    final r = await run(
      make(FakeTransport([], failConnect: true), FakeClaim([null])),
    );
    expect(r.failure, Failure.connectFailed);
  });

  test('помилки Wi-Fi повертаються одразу, без очікування 60 с', () async {
    var r = await run(
      make(FakeTransport([WifiState.authFailed]), FakeClaim([null])),
    );
    expect(r.failure, Failure.wifiAuth);
    r = await run(
      make(FakeTransport([WifiState.networkNotFound]), FakeClaim([null])),
    );
    expect(r.failure, Failure.networkNotFound);
    expect(sleeps, isEmpty);
  });

  test(
    'пристрій так і не підключився: тайм-аут 60 с = 20 пауз, 21 опитування',
    () async {
      final t = FakeTransport([WifiState.connecting]);
      final r = await run(make(t, FakeClaim([null])));
      expect(r.failure, Failure.notOnline);
      expect(sleeps.length, 20);
      expect(t.polls, 21, reason: 'останнє опитування на 60-й секунді');
    },
  );

  test(
    'claim: «пристрій ще не в мережі» повторюється, поки не вичерпано час',
    () async {
      final c = FakeClaim([
        conflict('device-offline'),
        conflict('device-offline'),
        null,
      ]);
      final r = await run(make(FakeTransport([WifiState.connected]), c));
      expect(r.ok, isTrue);
      expect(c.calls, 3);

      final never = FakeClaim([conflict('device-offline')]);
      final r2 = await run(
        make(FakeTransport([WifiState.connected]), never),
      );
      expect(r2.failure, Failure.notOnline);
    },
  );

  test('claim: чужий пристрій — одразу відмова, без повторів', () async {
    final c = FakeClaim([conflict('already-claimed')]);
    final r = await run(make(FakeTransport([WifiState.connected]), c));
    expect(r.failure, Failure.alreadyClaimed);
    expect(c.calls, 1);
  });

  test('діапазон за частотою каналу', () {
    expect(bandOf(2437), Band.ghz2);
    expect(bandOf(5180), Band.ghz5);
    expect(bandOf(5955), Band.ghz6);
    expect(bandOf(900), Band.unknown);
  });
}
