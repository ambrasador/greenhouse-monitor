#!/usr/bin/env python3
"""Життєвий цикл стека Compose: зупинка служб, старт з наявними томами, перезапуск backend; окремо —
зупинка за init: true і init: false (для backend і для контейнера без обробника SIGTERM).
Кожен вимір повторюється REPEAT разів (типово 3). Результат — results/compose-lifecycle.json.
Запуск: python3 calc7-compose.py   (потрібні Docker, образи й .env; стек може бути зупинено)"""
import json, os, statistics, subprocess, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get('CALC7_OUT', os.path.join(HERE, 'results'))
REPEAT = int(os.environ.get('REPEAT', '3'))
os.chdir(HERE)
os.makedirs(OUT, exist_ok=True)
NODE = os.environ.get('NODE_IMAGE', 'node:22.23.4-bookworm-slim')
NO_INIT = 'services:\n  backend: { init: false }\n'


def sh(*cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def timed(*cmd):
    t0 = time.time()
    r = sh(*cmd)
    return round(time.time() - t0, 2), r.returncode


def exit_code(files, service):
    cid = sh('docker', 'compose', *files, 'ps', '-aq', service).stdout.strip()
    return int(sh('docker', 'inspect', '-f', '{{.State.ExitCode}}', cid).stdout.strip())


def summary(values):
    return {'runs': values, 'median': round(statistics.median(values), 2)}


def stop_series(files, service):
    secs, codes = [], []
    for _ in range(REPEAT):
        sh('docker', 'compose', *files, 'up', '-d', '--wait')
        sec, _rc = timed('docker', 'compose', *files, 'stop', service)
        secs.append(sec)
        codes.append(exit_code(files, service))
    sh('docker', 'compose', *files, 'up', '-d', '--wait')
    return {**summary(secs), 'exitCodes': codes}


def pid1_demo(init):
    """Контейнер, у якому node — перший процес і не має обробника SIGTERM."""
    secs, codes = [], []
    for _ in range(REPEAT):
        name = 'calc7-pid1-demo'
        sh('docker', 'rm', '-f', name)
        args = ['docker', 'run', '-d', '--name', name] + (['--init'] if init else []) + [
            NODE, 'node', '-e', 'setInterval(() => {}, 1000)']
        sh(*args)
        time.sleep(1.0)
        sec, _rc = timed('docker', 'stop', name)
        secs.append(sec)
        codes.append(int(sh('docker', 'inspect', '-f', '{{.State.ExitCode}}', name).stdout.strip()))
        sh('docker', 'rm', '-f', name)
    return {**summary(secs), 'exitCodes': codes}


res = {'repeat': REPEAT}
sh('docker', 'compose', 'up', '-d', '--wait')
# 1. Зупинка кожної служби окремо (init: true для backend, як у compose.yaml)
res['stop'] = {svc: stop_series([], svc) for svc in ('web', 'backend', 'mosquitto')}
# 2. Зупинка backend без init
with tempfile.NamedTemporaryFile('w', suffix='.yaml', delete=False) as f:
    f.write(NO_INIT)
no_init_file = f.name
try:
    res['stopBackendNoInit'] = stop_series(['-f', 'compose.yaml', '-f', no_init_file], 'backend')
finally:
    os.remove(no_init_file)
sh('docker', 'compose', 'up', '-d', '--wait')
# 3. Контейнер без обробника сигналу: з init і без
res['pid1Demo'] = {'withoutInit': pid1_demo(False), 'withInit': pid1_demo(True)}
# 4. Старт з наявними томами: стек зупинено командою down (без -v)
up = []
for _ in range(REPEAT):
    sh('docker', 'compose', 'down')
    up.append(timed('docker', 'compose', 'up', '-d', '--wait')[0])
res['upExistingVolumes'] = summary(up)
# 5. Перезапуск одного backend: команда повертається раніше, ніж проба дасть healthy
rs, health = [], []
for _ in range(REPEAT):
    sh('docker', 'compose', 'up', '-d', '--wait')
    sec, _rc = timed('docker', 'compose', 'restart', '--timeout', '10', 'backend')
    rs.append(sec)
    health.append(sh('docker', 'compose', 'ps', '--format', '{{.Health}}', 'backend').stdout.strip())
res['restartBackend'] = {**summary(rs), 'healthRightAfter': health}
sh('docker', 'compose', 'up', '-d', '--wait')
json.dump(res, open(os.path.join(OUT, 'compose-lifecycle.json'), 'w'), ensure_ascii=False, indent=1)
print(json.dumps(res, ensure_ascii=False, indent=1))
