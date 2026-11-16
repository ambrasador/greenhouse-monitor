#!/usr/bin/env python3
"""Сценарій спостережуваності (розділ 7): стек Compose із чистими томами, 200 пристроїв × 4 метрики
з періодом 60 с (13,3 повідомлення/с), три потоки SSE, п’ять з’єднань Socket.IO, збій брокера на 25 с,
шквал хибних показань, розпилення паролів. Кожні 5 с знімається /metrics (усередині мережі Compose) і проба /readyz.
Результат у results (або CALC7_OUT): dashboard.jsonl, dashboard-events.json, dashboard-stats.json,
dashboard-sim.json, dashboard-clients.json, metrics-sample.txt, dashboard-backend.log"""
import json, os, re, secrets, subprocess, sys, threading, time

OUT = os.environ.get('CALC7_OUT', 'results')
os.makedirs(OUT, exist_ok=True)
os.chdir(os.path.dirname(os.path.abspath(__file__)))
DURATION, STEP = int(os.environ.get('DURATION', 240)), 5
OUTAGE = (100, 125)            # с від початку: зупинка й повернення брокера
BURST = (170, 185)             # хибні показання, 20/с
SSE = (40, 160)
WS = (60, 150)               # п’ять з’єднань Socket.IO
BAD_LOGIN = 140
KEEP = re.compile(r'^(greenhouse_|process_cpu_(user|system)_seconds_total|process_resident_memory_bytes|'
                  r'nodejs_heap_size_used_bytes|nodejs_eventloop_lag_(p99|mean)_seconds)')


def sh(*cmd, check=True, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, check=check, **kw)


def compose(*args, **kw):
    return sh('docker', 'compose', *args, **kw)


def parse(text):
    series = {}
    for line in text.splitlines():
        if line.startswith('#') or not KEEP.match(line):
            continue
        key, _, val = line.rpartition(' ')
        series[key] = float(val)
    return series


events = []
def note(what, **extra):
    events.append({'t': round(time.time() - T0, 2), 'what': what, **extra})


# 1. Чисті томи й старт стека
compose('down', '-v')
t = time.time()
compose('up', '-d', '--wait')
up_seconds = round(time.time() - t, 1)

# 2. 200 пристроїв і користувач (так само, як це робить admin-cli device-add / user-add)
reg = ("const D=require('better-sqlite3');const db=new D(process.env.DB_FILE);"
       "const ins=db.prepare('INSERT INTO devices VALUES (?,?,?,?)');const now=new Date().toISOString();"
       "db.transaction(()=>{for(let i=1;i<=200;i++)ins.run('gh1-s'+String(i).padStart(3,'0'),'Датчик '+i,'north',now)})();"
       "console.log(db.prepare('SELECT count(*) c FROM devices').get().c)")
print('пристроїв:', compose('exec', '-T', 'backend', 'node', '-e', reg).stdout.strip())
PASS = secrets.token_hex(12)
compose('exec', '-T', '-e', f'NEW_PASSWORD={PASS}', 'backend', 'node', 'admin-cli.js', 'user-add', 'dash', 'admin', '*')


def stats():
    rows = sh('docker', 'stats', '--no-stream', '--format', '{{json .}}').stdout.strip().splitlines()
    return [json.loads(r) for r in rows]


docker_stats = {'idle': stats()}
time.sleep(3)

# 3. Старт сценарію: спільний початок T0 для імітатора, клієнтів і знімача
T0 = time.time() + 4
env = {**os.environ, 'T0': str(int(T0 * 1000)), 'DURATION': str(DURATION), 'OUT': f'{OUT}/dashboard-sim.json',
       'BURST_FROM': str(BURST[0]), 'BURST_TO': str(BURST[1])}
sim = subprocess.Popen(['node', 'calc7-sim.cjs'], env=env, stdout=subprocess.PIPE, text=True)
cenv = {**env, 'OUT': f'{OUT}/dashboard-clients.json', 'USER': 'dash', 'PASS': PASS,
        'SSE_FROM': str(SSE[0]), 'SSE_TO': str(SSE[1]), 'WS_FROM': str(WS[0]), 'WS_TO': str(WS[1]),
        'BADLOGIN_AT': str(BAD_LOGIN)}
clients = subprocess.Popen(['node', 'calc7-clients.cjs'], env=cenv, stdout=subprocess.PIPE, text=True)


def at(rel):
    time.sleep(max(0, T0 + rel - time.time()))


def outage():
    at(OUTAGE[0]); a = time.time(); compose('stop', 'mosquitto'); note('broker-stop', took=round(time.time() - a, 2))
    at(OUTAGE[1]); a = time.time(); compose('start', 'mosquitto'); note('broker-start', took=round(time.time() - a, 2))
    while True:   # коли брокер знову «healthy» за його власною пробою
        h = compose('ps', '--format', '{{.Health}}', 'mosquitto').stdout.strip()
        if h == 'healthy':
            note('broker-healthy'); break
        time.sleep(0.5)


def load_stats():
    at(80); docker_stats['load'] = stats(); note('docker-stats-load')


threads = [threading.Thread(target=outage), threading.Thread(target=load_stats)]
[th.start() for th in threads]
cid = compose('ps', '-q', 'backend').stdout.strip()

# 4. Знімач: кожні STEP с /metrics + проба /readyz + стан healthcheck контейнера
probe = ("wget -qO- http://backend:3000/metrics; "
         "wget -S -qO /dev/null http://backend:3000/readyz 2>&1 | grep -m1 'HTTP/' >&2")
rows = []
for k in range(DURATION // STEP + 1):
    at(k * STEP)
    a = time.time()
    r = compose('exec', '-T', 'web', 'sh', '-c', probe, check=False)
    b = time.time()
    ready = (re.search(r'HTTP/1\.\d (\d{3})', r.stderr) or [None, '?'])[1]
    h = sh('docker', 'inspect', '-f', '{{.State.Health.Status}} {{.State.Health.FailingStreak}}', cid).stdout.split()
    rows.append({'t': round((a + b) / 2 - T0, 2), 'took': round(b - a, 2), 'ready': ready,
                 'health': h[0], 'streak': int(h[1]), 'series': parse(r.stdout)})
    if k * STEP == 90:
        open(f'{OUT}/metrics-sample.txt', 'w').write(r.stdout)

[th.join() for th in threads]
sim_out, cli_out = sim.communicate(timeout=60)[0], clients.communicate(timeout=60)[0]

# 5. Підсумкові перевірки: сповіщення про розпилення паролів і журнал
spray = compose('exec', '-T', 'backend', 'node', 'admin-cli.js', 'spray', '300', '10', check=False)
note('spray-check', exitCode=spray.returncode, out=spray.stdout.strip())
logs = compose('logs', 'backend', '--no-log-prefix').stdout
open(f'{OUT}/dashboard-backend.log', 'w').write(logs)

with open(f'{OUT}/dashboard.jsonl', 'w') as f:
    for row in rows:
        f.write(json.dumps(row, ensure_ascii=False) + '\n')
json.dump({'t0': T0, 'upSeconds': up_seconds, 'duration': DURATION, 'outage': OUTAGE, 'burst': BURST, 'sse': SSE, 'ws': WS,
           'badLogin': BAD_LOGIN, 'events': events, 'sim': json.loads(sim_out), 'clients': json.loads(cli_out)},
          open(f'{OUT}/dashboard-events.json', 'w'), ensure_ascii=False, indent=1)
json.dump(docker_stats, open(f'{OUT}/dashboard-stats.json', 'w'), ensure_ascii=False, indent=1)
print('готово: знімків', len(rows), 'рядків журналу', len(logs.splitlines()))
