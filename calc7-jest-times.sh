#!/usr/bin/env bash
# Час проєктів Jest (unit, integration, e2e): три прогони кожного, число тестів і «Time» із підсумку Jest;
# окремо — прогін із покриттям. Результат — results/jest-times.json
set -uo pipefail
cd "$(dirname "$0")"
OUT=${CALC7_OUT:-results}; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
J="node --experimental-vm-modules node_modules/jest/bin/jest.js"
for p in unit integration e2e; do
  for i in 1 2 3; do $J --selectProjects $p --json --outputFile="$OUT/jest-$p-$i.json" > "$OUT/jest-$p-$i.log" 2>&1; done
done
for i in 1 2 3; do $J --selectProjects unit integration --coverage > "$OUT/jest-cov-$i.log" 2>&1; done
# Покриття по модулях: покрито/усього для рядків, гілок і функцій
$J --selectProjects unit integration --coverage --coverageReporters=json-summary \
  --coverageDirectory="$OUT/cov-summary" > /dev/null 2>&1
python3 - "$OUT" <<'PY'
import json, re, statistics, sys
out = sys.argv[1]
res = {}
for p in ("unit", "integration", "e2e", "cov"):
    times, tests = [], None
    for i in (1, 2, 3):
        t = open(f"{out}/jest-{p}-{i}.log", encoding="utf8").read()
        m = re.search(r"^Time:\s+([\d.]+) s", t, re.M)
        n = re.search(r"^Tests:\s+(?:\d+ failed, )?(\d+) passed, (\d+) total", t, re.M)
        times.append(float(m.group(1)) if m else None)
        tests = int(n.group(2)) if n else tests
    res[p] = {"tests": tests, "seconds": times, "median": statistics.median([x for x in times if x is not None])}
# Тривалість окремих тестів (мс) за трьома прогонами: назва → [прогін 1, 2, 3]
per = {}
for p in ("unit", "integration", "e2e"):
    rows = {}
    for i in (1, 2, 3):
        data = json.load(open(f"{out}/jest-{p}-{i}.json", encoding="utf8"))
        for suite in data["testResults"]:
            for a in suite["assertionResults"]:
                rows.setdefault(a["fullName"], []).append(a["duration"])
    per[p] = rows
res["perTest"] = per
cs = json.load(open(f"{out}/cov-summary/coverage-summary.json", encoding="utf8"))
res["coverageModules"] = {k.split("/")[-1] if k != "total" else "total":
  {m: [v[m]["covered"], v[m]["total"]] for m in ("lines", "branches", "functions")} for k, v in cs.items()}
cov = open(f"{out}/jest-cov-1.log", encoding="utf8").read()
m = re.search(r"All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)", cov)
res["coverage"] = dict(zip(("stmts", "branch", "funcs", "lines"), map(float, m.groups()))) if m else None
json.dump(res, open(f"{out}/jest-times.json", "w"), ensure_ascii=False, indent=1)
print(json.dumps(res, ensure_ascii=False))
PY
