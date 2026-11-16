#!/usr/bin/env python3
"""Образи: «наївний» Dockerfile проти чотириетапного. Розміри на диску й у реєстрі, користувач процесу,
чи потрапив .env в образ, склад каталогу застосунку, час збирання з порожнього кешу.
Наївний образ збирається із записаного нижче Dockerfile і з копії дерева проєкту без .dockerignore,
але з .env і каталогом mobile (те, що лежить у робочому каталозі розробника).
Результат — results/images.json. Запуск: python3 calc7-images.py   (потрібні Docker і образи greenhouse-*:1.0)"""
import json, os, re, shutil, subprocess, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get('CALC7_OUT', os.path.join(HERE, 'results'))
os.makedirs(OUT, exist_ok=True)
NODE = os.environ.get('NODE_IMAGE', 'node:22.23.4-bookworm-slim')
NAIVE = f'''FROM {NODE}
WORKDIR /app
COPY . .
RUN npm install
CMD ["node", "main.js"]
'''
UNIT = {'kB': 1e-3, 'MB': 1.0, 'GB': 1e3}
KEEP = ['greenhouse-backend:1.0', 'greenhouse-web:1.0', 'node:22.23.4-bookworm-slim', 'nginx:1.30.6-alpine',
        'eclipse-mosquitto:2.1.2-alpine']


def sh(*cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def size_mb(s):
    m = re.fullmatch(r'([\d.]+)\s*(B|kB|MB|GB)', s)
    return float(m.group(1)) * (UNIT.get(m.group(2), 1e-6)) if m else None


def listing():
    """Розміри з таблиці docker image ls: DISK USAGE — розпаковано на диску, CONTENT SIZE — стиснено в реєстрі."""
    rows = {}
    for line in sh('docker', 'image', 'ls').stdout.splitlines()[1:]:
        p = line.split()
        if len(p) >= 4:
            rows[p[0]] = {'diskMB': size_mb(p[2]), 'contentMB': size_mb(p[3])}
    return rows


def probe(image):
    script = ('echo uid=$(id -u); echo entries=$(ls -A /app | wc -l); '
              'echo nodeModulesMB=$(du -sm /app/node_modules | cut -f1); '
              'if [ -e /app/.env ]; then echo envBytes=$(wc -c < /app/.env); else echo envBytes=0; fi; '
              'echo mobileMB=$( [ -d /app/mobile ] && du -sm /app/mobile | cut -f1 || echo 0 ); '
              "echo testFiles=$(find /app -name '*.test.js' -not -path '*/node_modules/*' | wc -l)")
    r = sh('docker', 'run', '--rm', '--entrypoint', 'sh', image, '-c', script)
    return {k: int(v) for k, v in (l.split('=') for l in r.stdout.split())}


def context_size(log):
    m = re.findall(r'transferring context: ([\d.]+\s*[kMG]?B)', log)
    return size_mb(m[-1].replace(' ', '')) if m else None


def lean_context():
    """Розмір контексту для робочих образів — з журналу холодного збирання (calc7-build.sh)."""
    path = os.path.join(OUT, 'build-cold.log')
    if not os.path.exists(path):
        return None
    text = open(path, encoding='utf8').read()
    step = re.search(r'#(\d+) \[backend internal\] load build context', text)
    sizes = re.findall(r'#%s transferring context: ([\d.]+\s*[kMG]?B)' % step.group(1), text) if step else []
    return size_mb(sizes[-1].replace(' ', '')) if sizes else None


tmp = tempfile.mkdtemp(prefix='naive7.')
try:
    for name in os.listdir(HERE):
        if name in ('node_modules', 'coverage', '.dockerignore', 'client'):
            continue
        src = os.path.join(HERE, name)
        if os.path.isfile(src) and (name.endswith(('.db', '.db-wal', '.db-shm'))):
            continue
        (shutil.copytree if os.path.isdir(src) else shutil.copy2)(src, os.path.join(tmp, name))
    shutil.copytree(os.path.join(HERE, 'client'), os.path.join(tmp, 'client'),
                    ignore=shutil.ignore_patterns('node_modules', 'dist'))
    with open(os.path.join(tmp, 'Dockerfile.naive'), 'w') as f:
        f.write(NAIVE)
    if not os.path.exists(os.path.join(tmp, '.env')):
        shutil.copy2(os.path.join(HERE, '.env.example'), os.path.join(tmp, '.env'))
    sh('docker', 'builder', 'prune', '-af')
    t0 = time.time()
    r = sh('docker', 'build', '--progress=plain', '-f', os.path.join(tmp, 'Dockerfile.naive'), '-t',
           'greenhouse-naive:probe', tmp)
    seconds = round(time.time() - t0, 1)
    assert r.returncode == 0, r.stderr[-800:]
    naive = {**probe('greenhouse-naive:probe'), 'buildSecondsNoCache': seconds,
             'contextMB': context_size(r.stdout + r.stderr)}
    imgs = listing()
    naive.update({'diskMB': imgs['greenhouse-naive:probe']['diskMB'],
                  'contentMB': imgs['greenhouse-naive:probe']['contentMB']})
finally:
    sh('docker', 'rmi', '-f', 'greenhouse-naive:probe')
    shutil.rmtree(tmp, ignore_errors=True)

sh('docker', 'compose', 'build')            # відновити кеш і образи після prune
imgs = listing()
hist = sh('docker', 'history', '--no-trunc', '--format', '{{.Size}}\t{{.CreatedBy}}', 'greenhouse-backend:1.0').stdout
layer = [size_mb(l.split('\t')[0]) for l in hist.splitlines() if 'node_modules' in l.split('\t')[1]]
lean = {**probe('greenhouse-backend:1.0'), 'contextMB': lean_context(), 'nodeModulesLayerMB': layer[0] if layer else None}
res = {'host': sh('docker', 'version', '--format', 'Docker {{.Server.Version}}').stdout.strip(),
       'images': {k: imgs[k] for k in KEEP},
       'naive': naive, 'lean': lean}
json.dump(res, open(os.path.join(OUT, 'images.json'), 'w'), ensure_ascii=False, indent=1)
print(json.dumps(res, ensure_ascii=False, indent=1))
