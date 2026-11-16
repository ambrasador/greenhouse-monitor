#!/bin/bash
# Вимірювання розділу 3 у тій послідовності, у якій їх виконано для підручника.
# Повний прогін триває близько 40 хвилин на двох ядрах; нічого іншого паралельно не запускайте.
# Потрібні: npm ci, npx playwright install chromium. Еталонні результати з підручника — results/book/
cd "$(dirname "$0")" || exit 1
R=results
mkdir -p $R
step() { echo "$(date +%H:%M:%S) $1" | tee -a $R/measure.log; }
run()  { local name=$1; shift; "$@" > "$R/$name.out" 2> "$R/$name.err"; sleep 3; }
rm -f $R/measure.log

step "збирання клієнта"
node client/build.mjs --prod

for m in sse sse-policy socketio socketio-policy; do
  step "повільний клієнт: $m"; run "slow-$m" timeout 200 node --expose-gc calc3-slow.mjs $m
done
step "байти на дроті";            run wire      timeout 400 node calc3-wire.mjs
step "MQTT напряму й через сервер"; run mqtt-raw  timeout 200 node calc3-mqtt-raw.mjs
step "швидкість підключення";     run ramp      timeout 300 node calc3-ramp.mjs
step "шторм: збій 5 с";           run storm     timeout 600 node calc3-storm.mjs 1000 5000
step "шторм: збій 0 с";           MODES=default,nojitter,full,full5 OUT=storm-d0.json \
                                  run storm-d0  timeout 900 node calc3-storm.mjs 1000 0
step "шторм: політика full5, збій 5 с"; MODES=full5 OUT=storm-full5.json \
                                  run storm-full5 timeout 600 node calc3-storm.mjs 1000 5000

step "імітація шторму"
FINE=$(node -e "const d=[1];for(let t=500;t<=20000;t+=500)d.push(t);d.push(30000,45000,60000,90000,120000,180000,240000,300000);console.log(d.join(','))")
run storm-sim-5000   node calc3-storm-sim.js 5000
run storm-sim-60000  node calc3-storm-sim.js 60000
SIM_U=10000 run storm-sim-sweep node calc3-storm-sim.js 1,1000,2000,3000,5000,10000,20000,30000,60000,120000,240000
SIM_U=10000 SIM_OUT=storm-sim-fine run storm-sim-fine node calc3-storm-sim.js "$FINE"

step "вартість розсилання"
rm -f $R/fan.json $R/fan_rec.json $R/fan_off.json $R/fan_naive.json
run fan        timeout 1500 node calc3-fan.mjs all
RECOVERY_MS=120000 run fan_rec timeout 600 node calc3-fan.mjs B socketio _rec
run fan_off    timeout 600 node calc3-fan.mjs B socketio _off
SSE_NAIVE=1 run fan_naive timeout 900 node calc3-fan.mjs all sse _naive

step "пам’ять з’єднань";          run mem       timeout 600 node calc3-mem.mjs
step "відновлення стану: вимкнено"; run recovery-off timeout 200 node --expose-gc calc3-recovery.mjs off
step "відновлення стану: ввімкнено"; run recovery-on  timeout 200 node --expose-gc calc3-recovery.mjs on
step "розмір клієнтських бібліотек"; run bundle timeout 200 node calc3-bundle.mjs

step "наскрізна перевірка в Chromium"
for spec in "socketio reset" "sse reset" "mqtt reset" "sse 503"; do
  set -- $spec
  for n in 1 2 3; do
    timeout 120 node e2e-browser.mjs "$1" "$2" > "$R/e2e-$1-$2-$n.out" 2> "$R/e2e-$1-$2-$n.err"
  done
done
step "готово"
