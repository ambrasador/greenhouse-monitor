#!/usr/bin/env python3
"""Падіння брокера: коли сервер це помічає, коли Docker позначає контейнер unhealthy і чи перезапускає його."""
import json, os, subprocess, time

OUT = os.environ.get('CALC7_OUT', 'results')
HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)
BACKEND = 'greenhouse-backend-1'
PROBE = "fetch('http://127.0.0.1:3000/readyz').then(r=>process.stdout.write(String(r.status))).catch(()=>process.stdout.write('ERR'))"


def run(*cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def snapshot():
    ready = run('docker', 'exec', BACKEND, 'node', '-e', PROBE).stdout.strip()
    h = run('docker', 'inspect', '-f', '{{.State.Health.Status}} {{.RestartCount}}', BACKEND).stdout.split()
    return ready, h[0], int(h[1])


def watch(seconds, t0, log, label):
    last = None
    end = time.time() + seconds
    while time.time() < end:
        s = snapshot()
        if s != last:
            log.append({'t': round(time.time() - t0, 1), 'phase': label, 'readyz': s[0], 'health': s[1], 'restarts': s[2]})
            last = s
        time.sleep(0.25)


log = []
assert snapshot()[0] == '200', 'стек має бути здоровим'
T0 = time.time()
run('docker', 'compose', 'stop', 'mosquitto')
log.append({'t': round(time.time() - T0, 1), 'phase': 'брокер зупинено'})
watch(70, T0, log, 'брокера немає')
T1 = time.time()
run('docker', 'compose', 'start', 'mosquitto')
log.append({'t': round(T1 - T0, 1), 'phase': 'брокер запущено'})
watch(40, T0, log, 'брокер повернувся')
json.dump(log, open(f'{OUT}/outage.json', 'w'), ensure_ascii=False, indent=1)
for e in log:
    print(e)
