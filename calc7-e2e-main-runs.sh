#!/usr/bin/env bash
# Повторні прогони e2e-main.mjs (підрозділ 7.4.2): SIGKILL посеред потоку, перезапуск, повтор, SIGTERM.
# Для кожного прогону фіксуються: скільки рядків пережило вбивство, скільки повторів доставив брокер,
# підсумок stats із запису shutdown, код завершення й тривалість процесу.
# Запуск: bash calc7-e2e-main-runs.sh [N]   (N — кількість прогонів, типово 12)
# Результат — e2e-main-runs.log (повний вивід) і e2e-main-runs.json у results (або CALC7_OUT)
set -uo pipefail
cd "$(dirname "$0")"
OUT=${CALC7_OUT:-results}; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
N=${1:-12}
: > "$OUT/e2e-main-runs.log"
for k in $(seq "$N"); do
  echo "=== прогін $k" >> "$OUT/e2e-main-runs.log"
  t0=$(date +%s.%N)
  node e2e-main.mjs >> "$OUT/e2e-main-runs.log" 2>&1; rc=$?
  t1=$(date +%s.%N)
  echo "rc=$rc час=$(python3 -c "print(round($t1 - $t0, 2))") с" >> "$OUT/e2e-main-runs.log"
done
python3 - "$OUT" <<'PY'
import json, re, statistics, sys
out = sys.argv[1]
runs = []
for block in open(f'{out}/e2e-main-runs.log', encoding='utf-8').read().split('=== прогін ')[1:]:
    survived = re.search(r'^2\. .*рядків (\d+) із 600', block, re.M)
    dups = re.search(r'повторів від брокера: (\d+)', block)
    stats = re.search(r'"stats":\{"stored":(\d+),"duplicate":(\d+)', block)
    end = re.search(r'rc=(\d+) час=([\d.]+) с', block)
    runs.append({'survived': int(survived.group(1)) if survived else None,
                 'redelivered_dups': int(dups.group(1)) if dups else 0,
                 'stored': int(stats.group(1)) if stats else None,
                 'duplicate': int(stats.group(2)) if stats else None,
                 'rc': int(end.group(1)), 'seconds': float(end.group(2))})
json.dump({'runs': runs}, open(f'{out}/e2e-main-runs.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
ok = sum(r['rc'] == 0 for r in runs)
alive = [r['survived'] for r in runs if r['survived'] is not None]
print(f'прогонів {len(runs)}, успішних {ok}; рядків у базі на момент вбивства: '
      f'{min(alive)}–{max(alive)} (медіана {statistics.median(alive)}); '
      f'тривалість, медіана: {statistics.median(r["seconds"] for r in runs)} с')
PY
