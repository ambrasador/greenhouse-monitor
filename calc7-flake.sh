#!/usr/bin/env bash
# Нестабільний тест: повторні запуски без зміни коду (підрозділ 7.4.3, вимір M5).
#   bash calc7-flake.sh suite [N]    увесь набір node:test: N звичайних прогонів і N із покриттям (типово 12 + 12)
#   bash calc7-flake.sh file [N]     лише passwords.test.js, N запусків (типово 400)
#   OLD_TEST=1 bash calc7-flake.sh file [N]
#                                    те саме для тесту до виправлення: у тимчасовій копії файла блок із h.slice(…)
#                                    замінено рядком із h.replace(/.$/, …); очікувана частка збоїв — 1/16 = 6,25 %
# Кожен запуск набору лишає TAP у $OUT/flake/, підсумок — summary-plain.txt і summary-cov.txt;
# підсумок режиму file — flaky-passwords-file.json (з OLD_TEST=1 — flaky-passwords-file-old.json).
# Нічого іншого паралельно не запускайте: прогони набору міряють і час.
set -uo pipefail
cd "$(dirname "$0")"
OUT=${CALC7_OUT:-results}; mkdir -p "$OUT/flake"; OUT=$(cd "$OUT" && pwd)
mode=${1:-suite}; n=${2:-}

suite_loop() {                      # suite_loop <N> <мітка> [прапорці node --test…]
  local count=$1 label=$2; shift 2
  : > "$OUT/flake/summary-$label.txt"
  for k in $(seq "$count"); do
    node --test --test-reporter=tap "$@" > "$OUT/flake/$label-$k.tap" 2>&1
    local rc=$?
    {
      echo "$label run $k rc=$rc $(grep -E '^# (pass|fail) ' "$OUT/flake/$label-$k.tap" | tr '\n' ' ')"
      grep -E '^\s*not ok' "$OUT/flake/$label-$k.tap" | head -5 || true   # без збоїв grep дає 1: це не помилка скрипта
    } | tee -a "$OUT/flake/summary-$label.txt"
  done
}

file_loop() {
  local count=$1 target=passwords.test.js suffix='' expected=0
  if [ "${OLD_TEST:-0}" = 1 ]; then
    target=.old-passwords.test.js; suffix=-old; expected=0.0625
    python3 - <<'PY'
t = open('passwords.test.js', encoding='utf-8').read()
start = t.index('  // Знак змінюють усередині ключа')
tail = "assert.equal(await verifyPassword('correct horse battery', tampered), false);\n"
end = t.index(tail) + len(tail)
old = "  assert.equal(await verifyPassword('correct horse battery', h.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))), false);\n"
open('.old-passwords.test.js', 'w', encoding='utf-8').write(t[:start] + old + t[end:])
PY
    trap 'rm -f .old-passwords.test.js' EXIT
  fi
  local failed=0 names; names=$(mktemp)
  local t0 t1; t0=$(date +%s.%N)
  for _ in $(seq "$count"); do
    if ! node --test --test-reporter=tap "$target" > "$OUT/flake/file$suffix-last.tap" 2>&1; then
      failed=$((failed + 1))
      grep -E '^\s*not ok' "$OUT/flake/file$suffix-last.tap" >> "$names"
    fi
  done
  t1=$(date +%s.%N)
  python3 - "$count" "$failed" "$names" "$t0" "$t1" "$expected" "$OUT/flaky-passwords-file$suffix.json" <<'PY'
import json, sys
count, failed, names, t0, t1, expected, out = sys.argv[1:]
count, failed = int(count), int(failed)
tests = sorted({line.strip() for line in open(names, encoding='utf-8') if line.strip()})
res = {'runs': count, 'failed': failed, 'share': round(failed / count, 4), 'expected': float(expected),
       'tests': tests, 'seconds': round(float(t1) - float(t0), 1)}
json.dump(res, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(json.dumps(res, ensure_ascii=False))
PY
  rm -f "$names"
}

case "$mode" in
  suite) suite_loop "${n:-12}" plain
         suite_loop "${n:-12}" cov --experimental-test-coverage ;;
  file)  file_loop "${n:-400}" ;;
  *)     echo "використання: bash calc7-flake.sh suite|file [N]" >&2; exit 2 ;;
esac
