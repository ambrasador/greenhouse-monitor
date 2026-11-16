#!/usr/bin/env bash
# Репетиція CI на чистій копії: команди з .github/workflows/ci.yml у порядку завдань, із часом кожного етапу.
# GitHub Actions тут не запускається: це перевірка того, що кожна команда конвеєра проходить з нуля,
# і заміри, з яких складається критичний шлях (lint → max(test, e2e) → image).
# Запуск: bash calc7-ci.sh   (потрібні Docker і Chromium для Playwright; CI_RUNS — кількість повних прогонів,
# типово 3; результат — results/ci-stages.json із медіанами етапів)
set -uo pipefail
SRC=$(cd "$(dirname "$0")" && pwd)
OUT=${CALC7_OUT:-$SRC/results}; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
RUNS=${CI_RUNS:-3}
: > "$OUT/ci-stages.jsonl"

stage() {                      # stage <прогін> <завдання> <назва> <команда...>
  local k=$1 job=$2 name=$3; shift 3
  local t0 t1 rc
  t0=$(date +%s.%N)
  "$@" > "$OUT/ci-$name-$k.log" 2>&1; rc=$?
  t1=$(date +%s.%N)
  python3 - "$k" "$job" "$name" "$t0" "$t1" "$rc" >> "$OUT/ci-stages.jsonl" <<'PY'
import json, sys
k, job, name, t0, t1, rc = sys.argv[1:]
print(json.dumps({"run": int(k), "job": job, "stage": name, "seconds": round(float(t1) - float(t0), 1),
                  "rc": int(rc)}, ensure_ascii=False))
PY
  tail -1 "$OUT/ci-stages.jsonl"
}

# Чиста копія: усе, що потрапило б у git (без node_modules, баз, секретів, збірок)
checkout() {
  tar -C "$SRC" --exclude=node_modules --exclude=coverage --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' \
      --exclude=.env --exclude=client/dist --exclude=mobile --exclude=shots-new --exclude=calc7-* --exclude=results -cf - . | tar -C "$WORK" -xf -
}

for k in $(seq "$RUNS"); do
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/ci7.XXXXXX")
  docker compose -f "$SRC/compose.yaml" down -v > /dev/null 2>&1      # порти 8080 і 1883 мають бути вільні
  docker builder prune -af > /dev/null 2>&1                            # образи збираються з порожнього кешу, як на новому ранері
  for img in greenhouse-backend:1.0 greenhouse-web:1.0; do docker rmi -f "$img" > /dev/null 2>&1; done

  stage "$k" setup checkout checkout
  cd "$WORK" || exit 1
  stage "$k" lint  npm-ci       npm ci --ignore-scripts
  stage "$k" lint  lint         npm run lint
  stage "$k" lint  audit        npm audit --omit=dev
  stage "$k" test  unit-node    npm test
  stage "$k" test  jest-cov     npm run test:coverage
  stage "$k" test  rules        npm run test:rules
  stage "$k" e2e   proc         npm run e2e
  stage "$k" e2e   build-client npm run build:client
  stage "$k" e2e   e2e          npm run test:e2e
  stage "$k" e2e   dashboard    npm run e2e:dashboard
  stage "$k" image smoke        ./smoke.sh
  docker compose down -v > /dev/null 2>&1
  cd "$SRC" && rm -rf -- "$WORK"
done

python3 - "$OUT" "$RUNS" <<'PY'
import json, statistics, sys
out, runs = sys.argv[1], int(sys.argv[2])
rows = [json.loads(l) for l in open(f"{out}/ci-stages.jsonl")]
keys = list(dict.fromkeys((r["job"], r["stage"]) for r in rows))
stages, med = [], {}
for job, name in keys:
    secs = [r["seconds"] for r in rows if (r["job"], r["stage"]) == (job, name)]
    med[(job, name)] = statistics.median(secs)
    stages.append({"job": job, "stage": name, "seconds": round(med[(job, name)], 1),
                   "min": min(secs), "max": max(secs),
                   "rc": max(r["rc"] for r in rows if (r["job"], r["stage"]) == (job, name))})
by = {}
for (job, _), v in med.items():
    by[job] = by.get(job, 0.0) + v
install = med[("lint", "npm-ci")]                    # test і e2e — окремі раннери: npm ci повторюється
withinst = {j: v + (install if j in ("test", "e2e") else 0.0) for j, v in by.items()}
crit = withinst["lint"] + max(withinst["test"], withinst["e2e"]) + withinst["image"]
res = {"runs": runs, "stages": stages,
       "jobSeconds": {k: round(v, 1) for k, v in by.items()},
       "jobSecondsWithInstall": {k: round(v, 1) for k, v in withinst.items()},
       "criticalPathSeconds": round(crit, 1),
       "sequentialSeconds": round(sum(med.values()), 1)}
json.dump(res, open(f"{out}/ci-stages.json", "w"), ensure_ascii=False, indent=1)
print(json.dumps({k: v for k, v in res.items() if k != "stages"}, ensure_ascii=False))
PY
