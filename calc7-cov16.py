#!/usr/bin/env python3
"""Чи змінило покриття Jest додавання двох випадків у модульні тести (мутанти 5 і 7, підрозділ 7.2.2).
Прогін із покриттям на повному наборі (18 модульних тестів) і на копії без цих двох випадків (16).
Результат — results/cov-16-vs-18.json. Запуск: python3 calc7-cov16.py   (потрібен npm ci)"""
import json, os, re, shutil, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get('CALC7_OUT', os.path.join(HERE, 'results'))
os.makedirs(OUT, exist_ok=True)
SPEC = 'jest/unit/alert-level.spec.js'
ROW = "    ['critical', 36.0, 'warning'],    // у гістерезисі warning: 35 + 2\n"
CMD = ['node', '--experimental-vm-modules', 'node_modules/jest/bin/jest.js', '--selectProjects', 'unit',
       'integration', '--coverage']


def run(root):
    r = subprocess.run(CMD, cwd=root, capture_output=True, text=True)
    out = r.stdout + r.stderr
    cov = re.search(r'All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)', out)
    tests = re.search(r'^Tests:\s+(?:\d+ failed, )?(\d+) passed, (\d+) total', out, re.M)
    return {'rc': r.returncode, 'tests': int(tests.group(2)),
            **dict(zip(('stmts', 'branch', 'funcs', 'lines'), map(float, cov.groups())))}


res = {'full': run(HERE)}
tmp = tempfile.mkdtemp(prefix='cov16.')
try:
    for name in os.listdir(HERE):
        if name in ('node_modules', 'coverage', 'mobile', '.git') or name.endswith(('.db', '.db-wal', '.db-shm')):
            continue
        src = os.path.join(HERE, name)
        (shutil.copytree if os.path.isdir(src) else shutil.copy2)(src, os.path.join(tmp, name))
    os.symlink(os.path.join(HERE, 'node_modules'), os.path.join(tmp, 'node_modules'))
    path = os.path.join(tmp, SPEC)
    text = open(path, encoding='utf8').read()
    assert text.count(ROW) == 1
    text = text.replace(ROW, '')
    text, n = re.subn(r"\n  test\('розрив рівно в 3 хв.*?\n  \}\);\n", '\n', text, flags=re.S)
    assert n == 1
    open(path, 'w', encoding='utf8').write(text)
    res['without'] = run(tmp)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
json.dump(res, open(os.path.join(OUT, 'cov-16-vs-18.json'), 'w'), ensure_ascii=False, indent=1)
print(json.dumps(res, ensure_ascii=False))
