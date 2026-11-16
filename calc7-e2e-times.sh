#!/usr/bin/env bash
# Час наскрізних рівнів піраміди: браузерний набір (e2e-dashboard.mjs, 23 перевірки), процесний (e2e-main.mjs:
# SIGKILL і перезапуск) і Jest+Playwright (npm run test:e2e). Три прогони кожного; результат — results/e2e-times.json
set -uo pipefail
cd "$(dirname "$0")"
OUT=${CALC7_OUT:-results}; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
[ -d client/dist ] || npm run build:client > /dev/null 2>&1
run() {
  local name=$1; shift; local r=() i
  for i in 1 2 3; do
    local t0 t1; t0=$(date +%s.%N)
    "$@" > "$OUT/e2e-time-$name-$i.log" 2>&1; local rc=$?
    t1=$(date +%s.%N)
    r+=("$(python3 -c "print(round($t1 - $t0, 1))"):$rc")
  done
  echo "$name ${r[*]}"
}
{
  run browser node e2e-dashboard.mjs
  run process node e2e-main.mjs
  run jest npm run test:e2e
} | python3 -c "
import json, sys, statistics
res = {}
for line in sys.stdin:
    name, *runs = line.split()
    secs = [float(r.split(':')[0]) for r in runs]; rcs = [int(r.split(':')[1]) for r in runs]
    res[name] = {'runs': secs, 'median': statistics.median(secs), 'exitCodes': rcs}
json.dump(res, open('$OUT/e2e-times.json', 'w'), ensure_ascii=False, indent=1)
print(json.dumps(res, ensure_ascii=False))
"
