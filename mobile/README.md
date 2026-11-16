# greenhouse_mobile: мобільний клієнт розділів 5–6

Еталонний мобільний клієнт Greenhouse Monitor з розділів 5 і 6 підручника: вхід, сеанс із оновленням токена й сховище токенів у Keychain і Keystore (розділ 6), кеш і черга дій без мережі, годинник сервера за заголовком `Date`, клієнт SSE, машина станів прив’язки пристрою по BLE, маршрутизація push-повідомлень, екрани списку пристроїв і пристрою. Перевірено з Flutter 3.47.9 і Dart 3.13.7. Версії залежностей зафіксовано в `pubspec.lock`; з іншими версіями SDK результат не гарантовано.

## Запуск

```
flutter pub get
flutter analyze
flutter test test/*.dart
```

Очікуваний результат: «No issues found!» і 135 тестів, усі пройдені (з них 24 віджет-тести; емулятор, телефон і мережа не потрібні).

Інтеграційні тести (21: 10 розділу 5 і 11 розділу 6) піднімають справжній еталонний сервер розділів 2–6 з імітацією FCM; тести розділу 6 вмикають вхід, ролі й область доступу. Потрібні Node.js 22 і `npm ci` у батьківському каталозі (там лежить `serve-mobile-bed.js`):

```
BED_DIR=.. flutter test test/integration
```

Без `BED_DIR` ці тести пропускаються.

Каталогів `android/` і `ios/` в архіві немає, бо застосунок на телефоні й в емуляторі не запускали. Команда `flutter create --platforms=android,ios .` створить їх. `main.dart` не створює `FirebasePushAdapter`: для цього потрібен проєкт Firebase (`google-services.json`, `GoogleService-Info.plist`), а підручник його не підключав. Адресу API задає `--dart-define=API_BASE=...`.

## Структура

| Каталог чи файл | Що містить |
| --- | --- |
| `lib/core` | Ядро — чистий Dart без імпортів Flutter (20 файлів): сеанс і токени `auth_session.dart`, годинник сервера `clock.dart`, клієнт API `api_client.dart`, кеш `cache.dart` і `repository.dart`, черга дій `offline_queue.dart` і `queue_driver.dart`, вибір каналу `channels.dart`, рамкування BLE `framing.dart`, прив’язка `provisioning.dart`, клієнт SSE `sse_client.dart` і ряд метрики `live_series.dart`, маршрутизатор push `push_router.dart` і `push_tokens.dart`, статус `status.dart`, злиття рядів `merge.dart`, словник домену `domain.dart`, `backoff.dart`, `store.dart`, `models.dart` |
| `lib/platform` | Адаптери до плагінів: `prefs_store.dart` (`shared_preferences`), `secure_token_store.dart` (`flutter_secure_storage`: Keychain і Keystore), `firebase_adapter.dart` (`firebase_messaging`), `lifecycle.dart` |
| `lib/ui` | Екран входу, екран списку пристроїв, екран пристрою, віджети статусу |
| `lib/main.dart` | Запуск, створення об’єктів, маршрути (`/devices/<id>?metric=<m>`) |
| `test/*.dart` | 111 модульних і 24 віджет-тести (розділ 6 додав `auth_session_test.dart` і `login_test.dart`); `test/integration` — 21 інтеграційний (розділ 6 додав `auth_bed_test.dart`); `test/fonts` — шрифт Roboto для тесту розкладки (`test/fonts/README.md`) |
| `fixtures/vectors.json` | 830 спільних векторів статусу, злиття й пауз; відповіді дає JavaScript-код розділу 4. Оновлюють командою `node tool/gen_vectors.mjs` із цього каталогу |
| `tool` | Сценарії вимірювань і перевірки відповідей (нижче) |

## Сценарії в `tool`

| Команда | Що робить | Де в підручнику |
| --- | --- | --- |
| `dart run tool/m1_duplicates.dart --base URL --n 1000 --mode none` (також `per-attempt`, `per-action`) | M1: скільки рядків команд створює сервер, якщо відповіді губляться; потрібен стенд, тож запускають із `../calc5-m1.mjs` | таблиця 5.12 |
| `dart run tool/m2_clock.dart --base URL --skew-ms 37300 --n 100 --gap-ms 137` | M2: похибка годинника сервера за заголовком `Date`; запускають із `../calc5-m2-m10.mjs` | таблиця 5.2 |
| `dart run tool/m6_ble.dart` | M6: кількість записів у характеристику BLE на повідомлення при *MTU* 23, 185 і 517; кожен кадр збирається назад | таблиця 5.5 |
| `dart run tool/m10_cancel.dart --base URL --ctl URL --impl abortable --mode cancel --runs 20` | M10: час скасування підписки SSE й слоти потоків; запускають із `../calc5-m2-m10.mjs` | таблиця 5.16 |
| `dart run tool/m11_store.dart` | M11: байти, передані сховищу чергою з *N* дій: ключ на дію проти єдиного списку | таблиця 5.14 |
| `flutter test tool/m12_layout_test.dart` | M12: ширина тексту стану в рядку черги на екрані 360 × 640 dp, шрифти Ahem і Roboto | таблиця 5.22 |
| `dart run tool/answers_check.dart` | Перевірка відповідей до питань 3 і 9 запуском коду клієнта | питання розділу 5 |

## Що не перевірено

- Емулятор і телефон не запускали: вигляд екрана, швидкість відмальовування, поведінку таймерів у фоні та мережу мобільного оператора книжка не вимірювала.
- Плагін BLE не підключали: транспорт прив’язки (`ProvisioningTransport`) замінено імітацією.
- `firebase_messaging` лише скомпільовано. Ланку «дотик по сповіщенню → маршрут» на телефоні не перевіряли: `PushRouter` будує рядок маршруту (тести маршрутизатора), а екран за рядком відкривається (віджет-тест).
- `flutter_secure_storage` лише скомпільовано: Keychain і Keystore не запускали, поведінку `first_unlock_this_device` та `android:allowBackup="false"` на пристрої не перевіряли; `SecureTokenStore` не має модульного тесту (сеанс перевіряють із `MemoryTokenStore`).
- Імітація FCM відтворює контракт HTTP v1, а не сервери Google.
- Шрифт Roboto в `test/fonts` замінює шрифт Android; iOS малює текст інакше.
