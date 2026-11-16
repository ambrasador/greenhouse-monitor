#!/bin/bash
# Вимірювання розділу 7 у тій послідовності, у якій їх виконано для підручника (M1–M12).
# Потрібні: Node.js 22 і `npm ci`, Python 3, git. Для кроків із Docker — Docker з Compose v2 і вільні порти 1883
# та 8080; для M4 — Chromium для Playwright; для M7 і перевірки закріплених дій — мережа (реєстр npm, GitHub).
# Без Docker скрипт виконує кроки, яким він не потрібен, а решту пропускає й повідомляє про це в журналі.
# Нічого іншого паралельно не запускайте: на двох ядрах паралельне навантаження спотворює час у рази,
# а M3 навмисно вмикає власне навантаження процесора.
# Змінні: CI_RUNS (повних прогонів CI, типово 3), REPEAT (повторів у M9, типово 3), RUNS (стартів стека, типово 3),
# DURATION (тривалість сценарію спостережуваності, с, типово 240; фази збою в ньому задано для 240 с).
# Результат — results/*.json, *.log; еталонні числа з підручника лежать у results/book/ch7-*.
cd "$(dirname "$0")" || exit 1
R=results
mkdir -p $R
export CALC7_OUT="$PWD/$R"
LOG=$R/measure7.log
rm -f $LOG
fails=0; skipped=0; made_env=0
step() { echo "$(date +%H:%M:%S) $1" | tee -a $LOG; }

HAVE_DOCKER=0
docker info > /dev/null 2>&1 && HAVE_DOCKER=1

run() {          # run <опис> <команда…>: виконує крок; помилка кроку не зупиняє прогін, а потрапляє в підсумок
  local what=$1; shift
  step "$what"
  "$@"
  local rc=$?
  if [ $rc -ne 0 ]; then step "  код завершення $rc: $what"; fails=$((fails + 1)); fi
}
run_docker() {   # те саме для кроку, якому потрібен Docker
  if [ $HAVE_DOCKER -eq 1 ]; then run "$@"; else step "пропущено (потрібен Docker): $1"; skipped=$((skipped + 1)); fi
}
stack_down() { [ $HAVE_DOCKER -eq 1 ] && docker compose down -v > /dev/null 2>&1; }

# Секрети для Compose: як у smoke.sh, одноразові; файл .env у git не потрапляє
if [ $HAVE_DOCKER -eq 1 ] && [ ! -f .env ]; then
  printf 'JWT_KEYS=k1:%s\nJWT_CURRENT=k1\nWEBHOOK_SECRETS=%s\nALLOWED_ORIGINS=http://localhost:8080\nLOG_LEVEL=info\n' \
    "$(openssl rand -base64 32)" "$(openssl rand -hex 32)" > .env
  made_env=1
fi
[ $HAVE_DOCKER -eq 1 ] || step "Docker недоступний: кроки M6, M8–M11 (стек Compose, образи, CI, promtool) буде пропущено"

# ---------------------------------------------------------------- без Docker
run "підготовка: Chromium для Playwright" bash -c "npx playwright install chromium > $R/playwright-install.log 2>&1"

run "M1: піраміда — кількість і час тестів node:test за рівнями (кожен файл окремо, зонд calc7-probe.cjs)" \
  bash -o pipefail -c "node calc7-pyramid.mjs | tee $R/pyramid.log"

run "M2: Jest — проєкти unit, integration, e2e (по 3 прогони) і прогін із покриттям" bash calc7-jest-times.sh
run "M2: мутації в nextLevel і findViolations (Jest 16 і 18 тестів, node:test)" node calc7-mutants.cjs
run "M2: чи змінило покриття Jest додавання двох випадків у модульні тести" python3 calc7-cov16.py
run "M2: покриття node:test зі звітом і без тестових файлів" bash calc7-coverage.sh

run "M3: час від PUBACK до рядка в базі, 1 500 показань на режим (спокій і навантаження процесора)" \
  node calc7-flaky.cjs 1500

run "M4: наскрізні рівні — браузерний набір, процесний, Jest + Playwright (по 3 прогони)" bash calc7-e2e-times.sh
run "M4: 12 прогонів e2e-main.mjs (SIGKILL, перезапуск, повтор, SIGTERM)" bash calc7-e2e-main-runs.sh 12

run "M5: нестабільний тест хешування — модель, 3 000 хешів" \
  bash -o pipefail -c "node calc7-flaky-hash.cjs | tee $R/flaky-hash.log"
run "M5: passwords.test.js — по 400 запусків після виправлення й до нього (OLD_TEST=1)" \
  bash -c "bash calc7-flake.sh file 400 && OLD_TEST=1 bash calc7-flake.sh file 400"
run "M5: увесь набір node:test — 12 прогонів звичайних і 12 із покриттям" bash calc7-flake.sh suite 12

run "M7: npm ci (холодний і теплий кеш, лише production), склад lock-файла, audit, SBOM" bash calc7-npm.sh

run "M10: міграція на базі, створеній кодом розділу 5 (без міграції і з нею)" \
  bash -c "node calc7-migrate-fail.js > $R/migrate-fail.log"

run "M12: ціна спостережуваності — метрики на повідомлення, відповідь /metrics, рядок журналу" node calc7-overhead.cjs
run "M12: мітка «пристрій» — розмір /metrics і час побудови для 200 – 100 000 пристроїв" \
  node calc7-cardinality.cjs $R/cardinality.json
run "7.8.1: які поля REDACT справді закриває" bash -c "node calc7-redact.js > $R/redact-probe.txt"
run "7.11: параметри правила тиші в п’яти доменах" python3 calc7-domains.py

# ---------------------------------------------------------------- Docker
run_docker "M6: час збирання образів у чотирьох станах кешу" bash calc7-build.sh
run_docker "M6: наївний і чотириетапний образи — розміри, користувач, вміст, холодне збирання" python3 calc7-images.py
run_docker "M9: старт стека з порожніх томів (два налаштування проб)" python3 calc7-startup.py
run_docker "M9: зупинка служб, старт із наявними томами, init: true і false" python3 calc7-compose.py
run_docker "M10: падіння брокера — коли сервер це помічає і що робить Docker" python3 calc7-outage.py
run_docker "M10: оновлення backend командою docker compose up -d --build — простій і відкат" python3 calc7-deploy.py
run_docker "M10: адреса backend у nginx — буквальне ім’я і resolver" python3 calc7-nginx-dns.py
stack_down
run_docker "M10: забутий файл у .dockerignore — образ збирається, контейнер падає" python3 calc7-missing-module.py

run "M8: actionlint на ci.yml і на зіпсованій копії; SHA закріплених дій проти тегів" python3 calc7-actionlint.py
run_docker "M8: репетиція CI на чистій копії (lint, тести, e2e, образ; CI_RUNS повних прогонів, типово 3)" bash calc7-ci.sh
stack_down
run_docker "M11: сценарій спостережуваності — 200 пристроїв, збій брокера, шквал відхилень, підбір імен" \
  bash -c "docker compose build > /dev/null 2>&1; python3 calc7-dashboard.py | tee $R/dashboard-run.log"
run_docker "M11: знімки /metrics → швидкості, квантилі, вікно збою" \
  bash -c "python3 calc7-dashboard-sum.py | tee $R/dashboard-sum.log"
run_docker "M12: ціна опитування /metrics на працюючому сервері (стек після сценарію)" python3 calc7-scrape.py
stack_down
run_docker "7.9: тести правил сповіщень promtool" npm run --silent test:rules
run_docker "7.9: мутації правил сповіщень" python3 calc7-rule-mutants.py

# ---------------------------------------------------------------- відповіді до питань
run "відповіді до питань розділу 7" bash -c "python3 calc7-questions.py > $R/questions.log"

[ $made_env -eq 1 ] && rm -f .env
step "готово: кроків із помилкою $fails, пропущено $skipped"
[ $fails -eq 0 ]
