#!/usr/bin/env bash
# Час збирання образів у чотирьох станах кешу та розмір образів; результат — JSON
set -euo pipefail
cd "$(dirname "$0")"
OUT="${CALC7_OUT:-results}"; mkdir -p "$OUT"
now() { date +%s.%N; }
declare -A T
build() {   # build <мітка>
  local t0 t1; t0=$(now)
  docker compose build --progress=plain > "$OUT/build-$1.log" 2>&1
  t1=$(now); T[$1]=$(python3 -c "print(round($t1-$t0,1))")
  echo "$1: ${T[$1]} с; кроків із кешу: $(grep -c ' CACHED' "$OUT/build-$1.log")"
}
cp api.js "$OUT/.api.js.bak"; cp package.json "$OUT/.package.json.bak"
restore() { cp "$OUT/.api.js.bak" api.js; cp "$OUT/.package.json.bak" package.json; }
trap 'restore; rm -f "$OUT/.api.js.bak" "$OUT/.package.json.bak"' EXIT

docker builder prune -af > /dev/null
build cold                                   # порожній кеш збирання
build warm                                   # нічого не змінилося
echo "// зміна коду $(now)" >> api.js
build code                                   # змінився лише код сервера
restore
build warm2                                  # повернули код: кеш вичерпує або ні
sed -i 's/"version": "1.0.0"/"version": "1.0.1"/' package.json
build manifest                               # змінився package.json: залежності ставляться заново
restore
docker compose build > /dev/null 2>&1        # повернути кеш у стан без змін

python3 - "$OUT" "${T[cold]}" "${T[warm]}" "${T[code]}" "${T[warm2]}" "${T[manifest]}" <<'PY'
import json, subprocess, sys
out, cold, warm, code, warm2, manifest = sys.argv[1], *map(float, sys.argv[2:])
imgs = {}
for name in ('greenhouse-backend:1.0', 'greenhouse-web:1.0'):
    sz = int(subprocess.check_output(['docker', 'image', 'inspect', name, '--format', '{{.Size}}']))
    imgs[name] = sz
json.dump({'seconds': {'cold': cold, 'warm': warm, 'code': code, 'afterRestore': warm2, 'manifest': manifest},
           'imageBytes': imgs}, open(f'{out}/build-times.json', 'w'), ensure_ascii=False, indent=1)
print(open(f'{out}/build-times.json').read())
PY
