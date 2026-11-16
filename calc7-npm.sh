#!/usr/bin/env bash
# Час npm ci (три повтори): холодний і теплий кеш, лише production; склад lock-файла, audit, SBOM
set -uo pipefail
cd "$(dirname "$0")"
OUT="${CALC7_OUT:-results}"; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
tar --exclude=./node_modules --exclude=./client/dist --exclude=./mobile --exclude='*.db*' --exclude=./.env -cf - . | tar -C "$W" -xf -
cd "$W"
export npm_config_cache="$W/.npm-cache" npm_config_update_notifier=false npm_config_fund=false
now() { date +%s.%N; }
: > "$OUT/npm-ci.txt"
run() {   # run <мітка> <чи очищати кеш> <аргументи npm ci>
  local label=$1 clear=$2; shift 2
  local times=()
  for _ in 1 2 3; do
    rm -rf node_modules; [ "$clear" = clear ] && rm -rf "$npm_config_cache"
    local t0 t1; t0=$(now)
    npm ci --ignore-scripts --no-audit "$@" > /dev/null 2>&1
    t1=$(now); times+=("$(python3 -c "print(round($t1-$t0,1))")")
  done
  echo "$label: ${times[*]} с; node_modules $(du -sm node_modules | cut -f1) МБ" | tee -a "$OUT/npm-ci.txt"
}
run "холодний кеш" clear
run "теплий кеш" keep
run "теплий кеш, лише production" keep --omit=dev
python3 - <<'PY' | tee -a "$OUT/npm-ci.txt"
import json
pk = json.load(open('package-lock.json'))['packages']
deps = {k: v for k, v in pk.items() if k}
dev = sum(1 for v in deps.values() if v.get('dev'))
print('пакетів у lock-файлі:', len(deps), '; production', len(deps) - dev, '; лише для розробки', dev)
PY
echo "audit --omit=dev: $(npm audit --omit=dev 2>&1 | grep -E 'vulnerabilit' | head -1)" | tee -a "$OUT/npm-ci.txt"
npm ci --ignore-scripts --no-audit > /dev/null 2>&1
echo "audit (усі): $(npm audit 2>&1 | grep -E 'vulnerabilit' | head -1)" | tee -a "$OUT/npm-ci.txt"
npm audit --json 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('audit (усі), за серйозністю:', d['metadata']['vulnerabilities'])" | tee -a "$OUT/npm-ci.txt"
if npm sbom --sbom-format cyclonedx --omit=dev > "$OUT/sbom-prod.cdx.json" 2> "$OUT/sbom.err"; then
  python3 - "$OUT/sbom-prod.cdx.json" <<'PY' | tee -a "$OUT/npm-ci.txt"
import json, sys, os
d = json.load(open(sys.argv[1]))
print('SBOM CycloneDX', d.get('specVersion'), '(production): компонентів', len(d.get('components', [])), '; файл', os.path.getsize(sys.argv[1]), 'Б')
PY
else echo "npm sbom: помилка: $(head -c 300 "$OUT/sbom.err")" | tee -a "$OUT/npm-ci.txt"; fi
# Звірка SBOM із деревом залежностей: чи збігається склад і чи є прямі залежності
echo "npm $(npm --version); npm ls --omit=dev --all: пакетів $(( $(npm ls --omit=dev --all --parseable 2>/dev/null | wc -l) - 1 ))" | tee -a "$OUT/npm-ci.txt"
python3 - "$OUT/sbom-prod.cdx.json" <<'PY' | tee -a "$OUT/npm-ci.txt"
import json, sys
names = {c['name'] for c in json.load(open(sys.argv[1])).get('components', [])}
direct = sorted(json.load(open('package.json'))['dependencies'])
print('прямі залежності, яких немає в SBOM:', [d for d in direct if d not in names])
PY
npm sbom --sbom-format cyclonedx > "$OUT/sbom-all.cdx.json" 2>/dev/null
python3 -c "import json,sys; print('SBOM повного дерева (без --omit):', len(json.load(open(sys.argv[1]))['components']), 'компонентів')" "$OUT/sbom-all.cdx.json" | tee -a "$OUT/npm-ci.txt"
rm -f "$OUT/sbom-all.cdx.json"
rm -rf node_modules; npm ci --ignore-scripts --no-audit --omit=dev > /dev/null 2>&1
echo "npm sbom на дереві, встановленому з --omit=dev: $(npm sbom --sbom-format cyclonedx --omit=dev 2>&1 >/dev/null | head -2 | tr '\n' ' ')" | tee -a "$OUT/npm-ci.txt"
