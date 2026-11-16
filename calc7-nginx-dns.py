#!/usr/bin/env python3
"""nginx і нова адреса backend. Буквальний proxy_pass http://backend:3000 перетворює ім’я на адресу один раз,
при старті; з resolver і змінною (nginx.conf у репозиторії) ім’я перерозв’язується кожні 5 с.
Адресу backend змінюємо навмисно: поки він зупинений, його адресу займає допоміжний контейнер.
Probe — GET /api/v1/devices/gh1-s01 через nginx кожні 0,5 с; 401 і 429 — відповіді живого сервера.
Результат — results/nginx-dns.json. Запуск: python3 calc7-nginx-dns.py   (потрібні Docker, образи й .env)"""
import http.client, json, os, subprocess, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get('CALC7_OUT', os.path.join(HERE, 'results'))
os.chdir(HERE)
os.makedirs(OUT, exist_ok=True)
ALIVE = (401, 429)
PAD_IMAGE = os.environ.get('PAD_IMAGE', 'alpine:3.20')


def sh(*cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def ip_of(name):
    return sh('docker', 'inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name).stdout.strip()


def probe():
    try:
        c = http.client.HTTPConnection('127.0.0.1', 8080, timeout=1.0)
        c.request('GET', '/api/v1/devices/gh1-s01')
        code = c.getresponse().status
        c.close()
        return code
    except Exception:
        return 0


def wait_alive(limit=30):
    end = time.time() + limit
    while time.time() < end:
        if probe() in ALIVE:
            return True
        time.sleep(0.5)
    return False


def network():
    return sh('docker', 'inspect', '-f', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}',
              'greenhouse-backend-1').stdout.strip()


def collapse(rows):
    out = []
    for t, c in rows:
        if not out or out[-1][1] != c:
            out.append([t, c])
    return out


def variant(label, files):
    sh('docker', 'compose', *files, 'up', '-d', '--wait', '--force-recreate')
    assert wait_alive(), 'стек не відповідає'
    ip0, net = ip_of('greenhouse-backend-1'), network()
    sh('docker', 'compose', *files, 'stop', 'backend')
    pads = []
    try:
        for i in range(4):                       # займаємо стару адресу
            name = f'calc7-pad-{i}'
            sh('docker', 'run', '-d', '--name', name, '--network', net, PAD_IMAGE, 'sleep', '600')
            pads.append(name)
            if ip_of(name) == ip0:
                break
        t0 = time.time()
        sh('docker', 'compose', *files, 'start', 'backend')
        rows = []
        while time.time() - t0 < 15:
            rows.append((round(time.time() - t0, 1), probe()))
            time.sleep(0.5)
        ip1 = ip_of('greenhouse-backend-1')
        res = {'label': label, 'ipBefore': ip0, 'ipAfter': ip1, 'padHoldsOldIp': ip0 in [ip_of(p) for p in pads],
               'timeline': collapse(rows), 'codeAfter15s': rows[-1][1]}
        alive = [t for t, c in rows if c in ALIVE]
        res['firstAliveAtS'] = alive[0] if alive else None
        if res['codeAfter15s'] not in ALIVE:      # адресу не оновлено: лікує лише reload
            sh('docker', 'compose', *files, 'exec', '-T', 'web', 'nginx', '-s', 'reload')
            time.sleep(1.0)
            res['codeAfterReload'] = probe()
        return res
    finally:
        for p in pads:
            sh('docker', 'rm', '-f', p)


src = open('nginx.conf', encoding='utf8').read()
literal = (src.replace('resolver 127.0.0.11 valid=5s;', '').replace('set $backend http://backend:3000;', '')
           .replace('proxy_pass $backend;', 'proxy_pass http://backend:3000;'))
assert literal.count('proxy_pass http://backend:3000;') == 2 and '$backend' not in literal
with tempfile.TemporaryDirectory() as d:
    conf = os.path.join(d, 'literal.conf')
    open(conf, 'w', encoding='utf8').write(literal)
    over = os.path.join(d, 'literal.yaml')
    open(over, 'w').write(f'services:\n  web:\n    volumes:\n      - {conf}:/etc/nginx/conf.d/default.conf:ro\n')
    res = {'literal': variant('буквальний proxy_pass', ['-f', 'compose.yaml', '-f', over]),
           'repo': variant('resolver + змінна (nginx.conf репозиторію)', ['-f', 'compose.yaml'])}
sh('docker', 'compose', 'up', '-d', '--wait', '--force-recreate')
# куди nginx у контейнері надсилає DNS-запити
res['resolvConf'] = [l for l in sh('docker', 'compose', 'exec', '-T', 'web', 'cat', '/etc/resolv.conf').stdout.splitlines()
                     if l.startswith('nameserver')]
json.dump(res, open(os.path.join(OUT, 'nginx-dns.json'), 'w'), ensure_ascii=False, indent=1)
print(json.dumps(res, ensure_ascii=False, indent=1))
