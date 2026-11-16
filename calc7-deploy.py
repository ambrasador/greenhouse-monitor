#!/usr/bin/env python3
"""Простій під час оновлення backend командою docker compose up -d --build: probe через nginx кожні 20 мс."""
import http.client, json, os, shutil, subprocess, threading, time

OUT = os.environ.get('CALC7_OUT', 'results')
HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)
samples = []        # (час, код)
stop = threading.Event()


def probe():
    while not stop.is_set():
        t = time.time()
        try:
            c = http.client.HTTPConnection('127.0.0.1', 8080, timeout=0.5)
            c.request('GET', '/api/v1/devices/gh1-s01')
            code = c.getresponse().status
            c.close()
        except Exception:
            code = 0
        samples.append((t, code))
        time.sleep(0.02)


def ip():
    return subprocess.run(['docker', 'inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', 'greenhouse-backend-1'],
                          capture_output=True, text=True).stdout.strip()


def deploy(label):
    ip_before = ip()
    th = threading.Thread(target=probe)
    samples.clear(); stop.clear(); th.start()
    time.sleep(1.0)
    t0 = time.time()
    r = subprocess.run(['docker', 'compose', 'up', '-d', '--build', '--wait', 'backend'], capture_output=True, text=True)
    t1 = time.time()
    time.sleep(3.0)
    stop.set(); th.join()
    bad = [(t, c) for t, c in samples if c not in (401, 429)]     # 401/429 — відповідь живого сервера
    first = bad[0][0] - t0 if bad else None
    last = bad[-1][0] - t0 if bad else None
    codes = {}
    for _, c in samples:
        codes[c] = codes.get(c, 0) + 1
    res = {'label': label, 'composeUpSeconds': round(t1 - t0, 2), 'ipBefore': ip_before, 'ipAfter': ip(),
           'rc': r.returncode, 'firstBadAtS': None if first is None else round(first, 2),
           'lastBadAtS': None if last is None else round(last, 2),
           'outageSeconds': None if not bad else round(last - first, 2), 'codes': codes, 'probeCount': len(samples),
           'finalCodes': [c for _, c in samples[-5:]]}
    print(json.dumps(res, ensure_ascii=False))
    return res


shutil.copy('api.js', f'{OUT}/.api.js.bak')
results = []
try:
    with open('api.js', 'a', encoding='utf8') as f:
        f.write('\n// деплой 1\n')
    results.append(deploy('оновлення коду'))
finally:
    shutil.copy(f'{OUT}/.api.js.bak', 'api.js')
    os.remove(f'{OUT}/.api.js.bak')
results.append(deploy('повернення коду'))
json.dump(results, open(f'{OUT}/deploy-downtime.json', 'w'), ensure_ascii=False, indent=1)
