import 'dart:math';

/// Затримка перед спробою [attempt] (1, 2, 3, …): стеля росте вдвічі до
/// [cap], сама затримка — рівномірно випадкова з [0, стеля) («повний джитер»).
Duration backoffDelay(
  int attempt, {
  Duration base = const Duration(seconds: 1),
  Duration cap = const Duration(seconds: 30),
  double Function()? rnd,
}) {
  final roll = rnd ?? Random().nextDouble;
  final ceiling = min(
    cap.inMilliseconds.toDouble(),
    base.inMilliseconds * pow(2.0, attempt - 1),
  );
  return Duration(milliseconds: (roll() * ceiling).floor());
}
