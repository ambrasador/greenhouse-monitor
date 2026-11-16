#!/usr/bin/env python3
"""Забутий файл у allow-list .dockerignore: образ збирається без помилок, а контейнер падає на require.
Дослід у тимчасовій копії проєкту (окремий проєкт Compose gh7missing), де з .dockerignore прибрано !migrate.js.
Фіксуємо: чи пройшло збирання, чи є файл в образі, що пише контейнер, скільки тривають спроби й паузи між ними
(restart: unless-stopped), як на це дивиться `docker compose up --wait`.
Результат — results/missing-module.json. Запуск: python3 calc7-missing-module.py
(потрібні Docker і .env; основний стек має бути зупинено: обидва стеки слухають порт 1883)"""
import json, os, re, shutil, subprocess, tempfile, threading, time
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get('CALC7_OUT', os.path.join(HERE, 'results'))
OBSERVE = float(os.environ.get('OBSERVE', '90'))
os.makedirs(OUT, exist_ok=True)
PROJECT = 'gh7missing'
NAME = f'{PROJECT}-backend-1'
IMAGE = 'gh7missing-backend:1.0'          # свій тег, щоб не зачепити образ основного стека


def sh(*cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def ts(s):
    return datetime.fromisoformat(re.sub(r'(\.\d{6})\d*Z', r'\1+00:00', s)).timestamp()


def poll(rows, stop):
    last = None
    while not stop.is_set():
        r = sh('docker', 'inspect', '-f',
               '{{.State.StartedAt}}|{{.State.FinishedAt}}|{{.RestartCount}}|{{.State.Status}}|{{.State.ExitCode}}', NAME)
        row = r.stdout.strip()
        if r.returncode == 0 and row != last:
            rows.append(row)
            last = row
        time.sleep(0.05)


tmp = tempfile.mkdtemp(prefix='missing7.')
try:
    for name in os.listdir(HERE):
        src = os.path.join(HERE, name)
        if name in ('node_modules', 'coverage', 'mobile') or name.endswith(('.db', '.db-wal', '.db-shm')):
            continue
        (shutil.copytree if os.path.isdir(src) else shutil.copy2)(src, os.path.join(tmp, name))
    ignore = os.path.join(tmp, '.dockerignore')
    text = open(ignore, encoding='utf8').read()
    assert text.count('!migrate.js\n') == 1
    open(ignore, 'w', encoding='utf8').write(text.replace('!migrate.js\n', ''))
    over = os.path.join(tmp, 'override.yaml')
    open(over, 'w').write(f'services:\n  backend:\n    image: {IMAGE}\n')
    compose = ['docker', 'compose', '-p', PROJECT, '-f', os.path.join(tmp, 'compose.yaml'), '-f', over,
               '--project-directory', tmp]
    build = sh(*compose, 'build', 'backend')
    res = {'buildRc': build.returncode,
           'migrateJsInImage': sh('docker', 'run', '--rm', '--entrypoint', 'sh', IMAGE, '-c',
                                  'ls /app/migrate.js').returncode == 0}
    rows, stop = [], threading.Event()
    th = threading.Thread(target=poll, args=(rows, stop))
    th.start()
    t0 = time.time()
    up = sh(*compose, 'up', '-d', '--wait', 'backend', timeout=180)
    res['upWaitRc'] = up.returncode
    res['upWaitSeconds'] = round(time.time() - t0, 1)
    res['upWaitMessage'] = (up.stderr.strip().splitlines() or [''])[-1]
    time.sleep(max(0.0, OBSERVE - (time.time() - t0)))
    stop.set()
    th.join()
    res['logTail'] = sh(*compose, 'logs', '--no-log-prefix', '--tail', '8', 'backend').stdout.strip().splitlines()
    runs = {}                                           # (початок, кінець) кожної спроби
    for row in rows:
        started, finished, count, status, code = row.split('|')
        if status == 'restarting':
            runs[started] = (ts(started), ts(finished), int(count), int(code))
    ordered = sorted(runs.values())
    res['attempts'] = [{'n': i + 1, 'runSeconds': round(f - s, 2), 'exitCode': code,
                        'pauseAfterSeconds': round(ordered[i + 1][0] - f, 2) if i + 1 < len(ordered) else None}
                       for i, (s, f, _c, code) in enumerate(ordered)]
    res['observedSeconds'] = round(OBSERVE, 1)
finally:
    sh(*compose, 'down', '-v')
    sh('docker', 'rmi', '-f', IMAGE)
    shutil.rmtree(tmp, ignore_errors=True)
json.dump(res, open(os.path.join(OUT, 'missing-module.json'), 'w'), ensure_ascii=False, indent=1)
print(json.dumps(res, ensure_ascii=False, indent=1))
