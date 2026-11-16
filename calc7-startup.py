#!/usr/bin/env python3
"""Старт стека Compose: хронологія подій Docker (start, health_status) для двох налаштувань проб.

  events-up.json  — start_interval 5 с, типове значення Docker (interval проб лишається 10 с, 15 с, 15 с)
  events-up2.json — як у репозиторії: start_interval 1 с протягом start_period

Кожне налаштування — RUNS стартів з порожніх томів; у файл потрапляє прогін із медіанною тривалістю.
Запуск: python3 calc7-startup.py   (потрібні Docker і образи; RUNS=3 типово; результат — results/)"""
import json, os, secrets, statistics, subprocess, sys, tempfile, time, base64

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get('CALC7_OUT', os.path.join(HERE, 'results'))
RUNS = int(os.environ.get('RUNS', '3'))
os.chdir(HERE)
os.makedirs(OUT, exist_ok=True)
SERVICES = [('greenhouse-mosquitto-1', 'mosquitto'), ('greenhouse-backend-1', 'backend'), ('greenhouse-web-1', 'web')]

# Compose вимагає start_period поруч із start_interval; значення ті самі, що в Dockerfile (інші поля проби
# беруться з образу)
DEFAULT_START_INTERVAL = """services:
  mosquitto: { healthcheck: { start_interval: 5s } }
  backend: { healthcheck: { start_period: 10s, start_interval: 5s } }
  web: { healthcheck: { start_period: 5s, start_interval: 5s } }
"""


def sh(*cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def ensure_env():
    """Як у smoke.sh: без .env створюємо одноразові секрети (файл не потрапляє ні в git, ні в образ)."""
    if os.path.exists('.env'):
        return False
    with open('.env', 'w') as f:
        f.write('JWT_KEYS=k1:%s\nJWT_CURRENT=k1\nWEBHOOK_SECRETS=%s\nALLOWED_ORIGINS=http://localhost:8080\n'
                % (base64.b64encode(secrets.token_bytes(32)).decode(), secrets.token_hex(32)))
    return True


def one_run(files):
    sh('docker', 'compose', *files, 'down', '-v')
    ev = subprocess.Popen(['docker', 'events', '--filter', 'type=container', '--format', '{{json .}}'],
                          stdout=subprocess.PIPE, text=True)
    time.sleep(0.5)
    t0 = time.time()
    r = sh('docker', 'compose', *files, 'up', '-d', '--wait')
    total = time.time() - t0
    if r.returncode != 0:
        print(r.stderr.strip()[-600:], flush=True)
    time.sleep(0.5)
    ev.terminate()
    out = ev.stdout.read()
    events = {short: [] for _, short in SERVICES}
    for line in out.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        name = e.get('Actor', {}).get('Attributes', {}).get('name')
        short = dict(SERVICES).get(name)
        action = e.get('Action', '')
        if short and action in ('start', 'health_status: healthy') and not any(a == action for _, a in events[short]):
            events[short].append((round(e['timeNano'] / 1e9 - t0, 2), action))
    sh('docker', 'compose', *files, 'down', '-v')
    return {'total': round(total, 2), 'rc': r.returncode, 'events': {dict(SERVICES_REV)[k]: v for k, v in events.items()}}


SERVICES_REV = [(short, name) for name, short in SERVICES]


def series(files, label, target):
    runs = [one_run(files) for _ in range(RUNS)]
    for r in runs:
        print(label, r['total'], 's rc=%d' % r['rc'], flush=True)
    med = statistics.median(r['total'] for r in runs)
    pick = min(runs, key=lambda r: abs(r['total'] - med))
    json.dump({'config': label, 'runs': [r['total'] for r in runs], 'median': round(med, 2),
               'total': pick['total'], 'events': pick['events']},
              open(os.path.join(OUT, target), 'w'), ensure_ascii=False, indent=1)


def default_start_interval():
    """Перша проба після старту: без --health-start-interval і з ним (контейнер alpine, проба `true`)."""
    res = {}
    for label, extra in (('типове значення', []), ('1 с', ['--health-start-interval', '1s'])):
        name = 'calc7-hc-demo'
        sh('docker', 'rm', '-f', name)
        t0 = time.time()
        sh('docker', 'run', '-d', '--name', name, '--health-cmd', 'true', '--health-interval', '60s',
           '--health-start-period', '30s', *extra, 'alpine:3.20', 'sleep', '60')
        status, t = '', None
        while time.time() - t0 < 30:
            status = sh('docker', 'inspect', '-f', '{{.State.Health.Status}}', name).stdout.strip()
            if status == 'healthy':
                t = round(time.time() - t0, 1)
                break
            time.sleep(0.1)
        sh('docker', 'rm', '-f', name)
        res[label] = t
    json.dump({'firstHealthySeconds': res}, open(os.path.join(OUT, 'start-interval-default.json'), 'w'),
              ensure_ascii=False, indent=1)
    print('перша проба після старту:', res, flush=True)


created = ensure_env()
try:
    with tempfile.NamedTemporaryFile('w', suffix='.yaml', delete=False) as f:
        f.write(DEFAULT_START_INTERVAL)
        override = f.name
    series(['-f', 'compose.yaml', '-f', override], 'start_interval 5 с (типове значення Docker)', 'events-up.json')
    series(['-f', 'compose.yaml'], 'start_interval 1 с (як у репозиторії)', 'events-up2.json')
    os.remove(override)
    default_start_interval()
finally:
    if created:
        os.remove('.env')
