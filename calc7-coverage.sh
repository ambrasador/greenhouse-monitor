#!/usr/bin/env bash
# Покриття основного набору node:test двома способами: з тестовими файлами у звіті (типово) і без них.
# Результат — рядки «all files» обох звітів у results/nodecov-summary.txt
set -uo pipefail
cd "$(dirname "$0")"
OUT=${CALC7_OUT:-results}; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
{
  echo "з тестовими файлами у звіті:"
  node --test --experimental-test-coverage 2>&1 | grep -E "^# (all files|tests|pass|fail) "
  echo "без тестів і допоміжних скриптів:"
  node --test --experimental-test-coverage \
    --test-coverage-exclude='**/*.test.js' --test-coverage-exclude='**/testkit.js' \
    --test-coverage-exclude='**/calc*' --test-coverage-exclude='**/bench*' --test-coverage-exclude='**/e2e-*' \
    --test-coverage-exclude='**/jest/**' --test-coverage-exclude='**/client/**' --test-coverage-exclude='**/examples/**' \
    --test-coverage-exclude='**/mobile/**' --test-coverage-exclude='**/node_modules/**' 2>&1 \
    | tee "$OUT/nodecov-src.log" | grep -E "^# (all files|tests|pass|fail) "
} > "$OUT/nodecov-summary.txt"
cat "$OUT/nodecov-summary.txt"
