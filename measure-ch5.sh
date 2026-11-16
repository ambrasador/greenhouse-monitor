#!/bin/bash
# Вимірювання розділу 5 у тій послідовності, у якій їх виконано для підручника.
# Потрібні: npm ci; Flutter 3.47.9 (Dart 3.13.7) у PATH; доступ до реєстру pub.dev для `flutter pub get`.
# Нічого іншого паралельно не запускайте: стенд і клієнт Dart ділять два ядра.
# Еталонні результати з підручника — results/book/ch5-*
cd "$(dirname "$0")" || exit 1
R=results
mkdir -p $R
step() { echo "$(date +%H:%M:%S) $1" | tee -a $R/measure5.log; }
rm -f $R/measure5.log

step "залежності Flutter-пакета"
(cd mobile && flutter pub get > /dev/null)

step "M1: дублікати команд при втрачених відповідях (15 прогонів)"
node calc5-m1.mjs 1000 $R/m1.json > $R/m1.log
step "M2 і M10: годинник за Date; скасування підписки SSE (близько хвилини на прогін async*)"
node calc5-m2-m10.mjs $R/m2.json $R/m10.json > $R/m2-m10.log
step "M3: сповіщень за добу при шумі біля порога"
node calc5-m3.mjs $R/m3.json
step "M6: записи BLE на повідомлення"
(cd mobile && dart run tool/m6_ble.dart) > $R/m6.json
step "M8: рядки коду за шарами"
python3 calc5-loc.py $R/m8.json
step "M11: байти сховища"
(cd mobile && dart run tool/m11_store.dart) > $R/m11.json
step "M12: розкладка тексту в рядку черги"
(cd mobile && flutter test tool/m12_layout_test.dart) > $R/m12.full.log 2>&1
grep -E '^M12 |All tests passed' $R/m12.full.log > $R/m12.log
step "M13: параметри для п’яти доменів"
python3 calc5-domains.py $R/m13.json > $R/m13.log
step "відповіді до питань розділу"
{ python3 calc5-answers.py; node calc5-answers-fcm.js; (cd mobile && dart run tool/answers_check.dart); } > $R/answers.log 2>&1
step "готово"
