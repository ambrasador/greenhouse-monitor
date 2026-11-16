#!/bin/bash
# Вимірювання розділу 4 у тій послідовності, у якій їх виконано для підручника.
# Повний прогін триває близько 30 хвилин на двох ядрах; нічого іншого паралельно не запускайте.
# Потрібні: npm ci, npx playwright install chromium. Еталонні результати з підручника — results/book/
cd "$(dirname "$0")" || exit 1
R=results
mkdir -p $R
step() { echo "$(date +%H:%M:%S) $1" | tee -a $R/measure4.log; }
run()  { local name=$1; shift; "$@" > "$R/$name.out" 2> "$R/$name.err"; sleep 2; }
rm -f $R/measure4.log

step "збирання клієнта (робоча збірка) і сторінок вимірювань"
node client/build.mjs --prod
node bench4/build.mjs
node calc4-verify/build.mjs

step "розрахунки на синтетичних рядах";  run contrast  node calc4-contrast.mjs
                                         run peaks     node calc4-peaks.mjs
                                         run track     node calc4-track.mjs
                                         run domains   node calc4-domains.mjs
step "час проріджування";                run lttb-time node calc4-lttb-time.mjs
step "запити й байти історії";           run payload   node calc4-payload.mjs
step "ширина області графіка";           run plotwidth node calc4-plotwidth.mjs
step "розмір бібліотек";                 run bundle    node calc4-bundle.mjs
step "малювання графіка (10–15 хв)";     run render    node calc4-render.mjs
step "перемальовування карток";          run rerender  node calc4-rerender.mjs
step "вартість кадру живих точок (4 прогони, у книзі — медіана)"
for i in 1 2 3 4; do run merge-$i node calc4-merge.mjs; done
step "запити до API в сценарії оператора"; run requests node calc4-requests.mjs
step "розмір кеша запитів";              run cache     node calc4-cache.mjs
step "малі екрани";                      run mobile    node calc4-mobile.mjs
step "наскрізна перевірка дашборда";     run e2e-dashboard node e2e-dashboard.mjs
step "перевірки в окремих сторінках";    run verify-run node calc4-verify/run.mjs
                                         run verify-a11y node calc4-verify/a11y.mjs

step "StrictMode: режим розробки"
node client/build.mjs
run strict-dev node calc4-strict.mjs dev
step "StrictMode: робоча збірка"
node client/build.mjs --prod
run strict-prod node calc4-strict.mjs prod
step "готово"
