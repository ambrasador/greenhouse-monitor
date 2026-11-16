import 'dart:io';

import 'package:flutter/services.dart';

/// Підключає Roboto з test/fonts. За замовчуванням `flutter test` малює все
/// шрифтом Ahem, де кожен символ — квадрат завширшки в одну em, тож ширини
/// тексту в тесті не збігаються з телефоном.
Future<void> loadRoboto() async {
  final loader = FontLoader('Roboto');
  for (final weight in ['Regular', 'Medium']) {
    // синхронно: тіло testWidgets живе в fake-async, справжній ввід-вивід
    // у ньому не завершується
    final bytes = File('test/fonts/Roboto-$weight.ttf').readAsBytesSync();
    loader.addFont(Future.value(ByteData.sublistView(bytes)));
  }
  await loader.load();
}
