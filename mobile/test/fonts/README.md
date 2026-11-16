# Шрифт для перевірки розкладки

`Roboto-Regular.ttf` і `Roboto-Medium.ttf` (версія 2.137, 2017) взято з
Flutter SDK: `bin/cache/artifacts/material_fonts/`. Ліцензія — Apache License,
Version 2.0 (<https://www.apache.org/licenses/LICENSE-2.0>), текст вбудовано
в таблицю `name` кожного файлу.

Навіщо вони тут: у `flutter test` усі літери малюються шрифтом Ahem — квадратом
em × em, тож ширини тексту в тестах не збігаються з телефоном. Тест розкладки
(`ui_test.dart`, «на екрані 360 dp …») підключає Roboto через `FontLoader`.
Це заміна шрифту Android, а не шрифт конкретного телефона: iOS малює текст
шрифтом San Francisco з іншими ширинами.
