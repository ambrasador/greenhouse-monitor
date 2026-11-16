#!/bin/bash
# Вимірювання розділу 6 у тій послідовності, у якій їх виконано для підручника.
# Потрібні: npm ci. Flutter не потрібен. Нічого іншого паралельно не запускайте:
# сервер і autocannon (M5) ділять два ядра, а M1–M3 міряють час процесора.
# Еталонні результати з підручника — results/book/ch6-*
cd "$(dirname "$0")" || exit 1
R=results
mkdir -p $R
step() { echo "$(date +%H:%M:%S) $1" | tee -a $R/measure6.log; }
rm -f $R/measure6.log

step "M1: вартість хешування пароля (п’ять наборів scrypt, параметри стенда, PBKDF2; кожен рядок — окремий процес)"
node calc6-scrypt.mjs $R/scrypt.json
step "M2: сто одночасних входів і подійний цикл (три способи хешування)"
node calc6-loop.mjs $R/loop.json
step "M3: чи видно за часом відповіді, що ім’я існує (по 60 запитів)"
node calc6-timing.mjs $R/timing.json 60
step "M4: підпис і перевірка токена доступу: HS256, RS256, ES256"
node calc6-jwt.mjs $R/jwt.json
step "M5: що автентифікація додає до запиту читання (autocannon, 3 прогони)"
node calc6-overhead.mjs $R/overhead.json > $R/overhead.log
step "M5б: з чого складається додатковий час на запит"
node calc6-authcost.mjs $R/authcost.json
step "M6: підпис вебхука: вартість, пам’ять кешу повторів, підбір слабкого секрету"
node --expose-gc calc6-webhook.mjs $R/webhook.json
step "M7: приватність: сітка координат, псевдонім, пакети видалення"
node calc6-privacy.mjs $R/privacy.json
step "M8: ротація refresh-токена: час обміну й обсяг таблиці"
node calc6-refresh.mjs $R/refresh.json
step "M9: фільтр області доступу в списку пристроїв (1 000, 10 000 і 100 000 пристроїв)"
node calc6-scopelist.mjs $R/scopelist.json
step "M10: запис у журнал аудиту"
node calc6-audit.mjs $R/audit.json
step "числа для таблиць і відповіді до питань розділу"
node calc6-answers.mjs $R/answers.json
python3 calc6-questions.py > $R/questions.log
step "готово"
