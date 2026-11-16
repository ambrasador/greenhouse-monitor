#!/usr/bin/env python3
"""Обробка знімків /metrics сценарію спостережуваності: швидкості, квантилі з кошиків гістограми,
вікно збою брокера, звірка з імітатором. Вхід — results/dashboard*.json*, вихід — dashboard-summary.json."""
import json, os, re
OUT = os.environ.get('CALC7_OUT', 'results')
rows = [json.loads(l) for l in open(f'{OUT}/dashboard.jsonl')]
ev = json.load(open(f'{OUT}/dashboard-events.json'))
T0 = ev['t0']


def get(s, name, **labels):
    """Значення ряду; ряд, якого ще немає, — нуль (як після ініціалізації лічильника)."""
    for k, v in s.items():
        m = re.match(r'^([^{ ]+)(?:\{(.*)\})?$', k)
        if m.group(1) != name:
            continue
        have = dict(re.findall(r'(\w+)="([^"]*)"', m.group(2) or ''))
        if all(have.get(a) == b for a, b in labels.items()):
            return v
    return 0.0


def total(s, name, **labels):
    out = 0.0
    for k, v in s.items():
        m = re.match(r'^([^{ ]+)(?:\{(.*)\})?$', k)
        if m.group(1) != name:
            continue
        have = dict(re.findall(r'(\w+)="([^"]*)"', m.group(2) or ''))
        if all(have.get(a) == b for a, b in labels.items()):
            out += v
    return out


def buckets(s, name):
    b = {}
    for k, v in s.items():
        m = re.match(rf'^{name}_bucket\{{le="([^"]+)"\}}$', k)
        if m:
            b[float('inf') if m.group(1) == '+Inf' else float(m.group(1))] = v
    return b


def quantile(q, b0, b1):
    """histogram_quantile за різницею кумулятивних кошиків (лінійна інтерполяція всередині кошика)."""
    les = sorted(b1)
    d = [(le, b1[le] - b0.get(le, 0)) for le in les]
    n = d[-1][1]
    if n <= 0:
        return None
    rank, prev_le, prev_c = q * n, 0.0, 0.0
    for le, c in d:
        if c >= rank:
            if le == float('inf'):
                return prev_le
            return prev_le + (le - prev_le) * (rank - prev_c) / (c - prev_c) if c > prev_c else le
        prev_le, prev_c = le, c
    return None


REASONS = ['out_of_range', 'bad_json', 'unknown_metric', 'bad_ts']
pts = []
for a, b in zip(rows, rows[1:]):
    s0, s1, dt = a['series'], b['series'], b['t'] - a['t']
    d = lambda n, **l: (total(s1, n, **l) - total(s0, n, **l)) / dt
    cpu = lambda s: get(s, 'process_cpu_user_seconds_total') + get(s, 'process_cpu_system_seconds_total')
    last = get(s1, 'greenhouse_last_reading_timestamp_seconds')
    http = lambda lo, hi: sum(
        (v - s0.get(k, 0)) for k, v in s1.items() if k.startswith('greenhouse_http_request_seconds_count')
        and lo <= int(re.search(r'status="(\d+)"', k).group(1)) < hi) / dt
    q50 = quantile(0.50, buckets(s0, 'greenhouse_ingest_seconds'), buckets(s1, 'greenhouse_ingest_seconds'))
    q99 = quantile(0.99, buckets(s0, 'greenhouse_ingest_seconds'), buckets(s1, 'greenhouse_ingest_seconds'))
    dc = get(s1, 'greenhouse_ingest_seconds_count') - get(s0, 'greenhouse_ingest_seconds_count')
    ds = get(s1, 'greenhouse_ingest_seconds_sum') - get(s0, 'greenhouse_ingest_seconds_sum')
    pts.append({
        't': b['t'], 'stored': d('greenhouse_readings_total', result='stored'),
        'duplicate': d('greenhouse_readings_total', result='duplicate'),
        'rejected': d('greenhouse_readings_total', result='rejected'),
        'byReason': {r: d('greenhouse_rejected_total', reason=r) for r in REASONS},
        'p50ms': None if q50 is None else q50 * 1000, 'p99ms': None if q99 is None else q99 * 1000,
        'meanMs': None if dc <= 0 else ds / dc * 1000,
        'broker': get(s1, 'greenhouse_broker_connected'), 'subs': get(s1, 'greenhouse_feed_subscriptions'),
        'ws': get(s1, 'greenhouse_ws_connections'),
        'ageSec': (T0 + b['t'] - last) if last else None, 'ready': b['ready'], 'health': b['health'], 'streak': b['streak'],
        'http2xx': http(200, 300), 'http4xx': http(400, 500), 'http5xx': http(500, 600),
        'loginFail': d('greenhouse_audit_events_total', action='login', outcome='fail'),
        'cpuPct': (cpu(s1) - cpu(s0)) / dt * 100, 'rssMB': get(s1, 'process_resident_memory_bytes') / 2**20,
        'heapMB': get(s1, 'nodejs_heap_size_used_bytes') / 2**20, 'lagP99ms': get(s1, 'nodejs_eventloop_lag_p99_seconds') * 1000,
    })

steady = [p for p in pts if 10 <= p['t'] <= 95]
mean = lambda xs: sum(xs) / len(xs) if xs else None
# Квантилі всього вікна — за сумою приростів кошиків, а не як середнє квантилів п’ятисекундних вікон:
# квантилі не усереднюють (одне повільне повідомлення у вікні з ~68 тягне його p99 вгору, а в середнє потрапляє вагою вікна)
ING = 'greenhouse_ingest_seconds'
first = next(i for i, p in enumerate(pts) if 10 <= p['t'] <= 95)
last_i = max(i for i, p in enumerate(pts) if 10 <= p['t'] <= 95)        # pts[i] побудовано з rows[i] і rows[i + 1]
w0, w1 = rows[first]['series'], rows[last_i + 1]['series']
pooled = lambda q, a, b: quantile(q, buckets(a, ING), buckets(b, ING))
n_win = get(w1, ING + '_count') - get(w0, ING + '_count')
p99w = [p['p99ms'] for p in steady if p['p99ms'] is not None]
allp99 = [(p['p99ms'], p['t'], i) for i, p in enumerate(pts) if p['p99ms'] is not None]
worst = max(allp99)                                                      # (p99 вікна, t, індекс вікна)
wb0, wb1 = buckets(rows[worst[2]]['series'], ING), buckets(rows[worst[2] + 1]['series'], ING)
whole = {'windowsWithData': len(allp99), 'p99MeanOfWindows': mean([x[0] for x in allp99]),
         'p99MeanWithoutWorst': mean([x[0] for x in allp99 if x[2] != worst[2]]),
         'p99Worst': worst[0], 'p99WorstAt': worst[1],
         'worstWindowBuckets': {str(le): wb1[le] - wb0.get(le, 0) for le in sorted(wb1)},
         'messages': get(rows[-1]['series'], ING + '_count'),
         'p50ms': pooled(0.50, {}, rows[-1]['series']) * 1000, 'p99ms': pooled(0.99, {}, rows[-1]['series']) * 1000,
         'meanMs': get(rows[-1]['series'], ING + '_sum') / get(rows[-1]['series'], ING + '_count') * 1000,
         'bucketsCumulative': {str(k): v for k, v in buckets(rows[-1]['series'], ING).items()}}
broker0 = next((p['t'] for p in pts if p['broker'] == 0), None)
back1 = next((p['t'] for p in pts if broker0 is not None and p['t'] > broker0 and p['broker'] == 1), None)
ready503 = [p['t'] for p in pts if p['ready'] == '503']
last = rows[-1]['series']
sample = open(f'{OUT}/metrics-sample.txt').read().splitlines()
events = {e['what']: e for e in ev['events']}
summary = {
    'points': pts,
    'steady': {'window': [10, 95], 'storedPerSec': mean([p['stored'] for p in steady]),
               'cpuPct': mean([p['cpuPct'] for p in steady]), 'rssMB': mean([p['rssMB'] for p in steady]),
               'messages': n_win,
               'p50ms': pooled(0.50, w0, w1) * 1000, 'p99ms': pooled(0.99, w0, w1) * 1000,
               'meanMs': (get(w1, ING + '_sum') - get(w0, ING + '_sum')) / n_win * 1000,
               'p99MeanOfWindows': mean(p99w), 'p99MedianOfWindows': sorted(p99w)[len(p99w) // 2],
               'p99MaxWindow': max(p99w), 'p99MaxWindowAt': next(p['t'] for p in steady if p['p99ms'] == max(p99w)),
               'windows': len(steady),
               'lagP99ms': mean([p['lagP99ms'] for p in steady])},
    'outage': {'stopEvent': events['broker-stop']['t'], 'startEvent': events['broker-start']['t'],
               'healthyEvent': events['broker-healthy']['t'], 'firstScrapeBrokerDown': broker0,
               'firstScrapeBrokerUp': back1, 'ready503': [min(ready503), max(ready503)] if ready503 else None,
               'maxAgeSec': max(p['ageSec'] for p in pts if p['ageSec'] is not None),
               'maxHealthStreak': max(p['streak'] for p in pts), 'healthStates': sorted({p['health'] for p in pts})},
    'reconcile': {'simPublished': ev['sim']['published'], 'simDuplicates': ev['sim']['duplicates'], 'simInvalid': ev['sim']['invalid'],
                  'simSkippedOffline': ev['sim']['skippedOffline'],
                  'stored': get(last, 'greenhouse_readings_total', result='stored'),
                  'duplicate': get(last, 'greenhouse_readings_total', result='duplicate'),
                  'rejected': get(last, 'greenhouse_readings_total', result='rejected'),
                  'byReason': {r: get(last, 'greenhouse_rejected_total', reason=r) for r in REASONS},
                  'loginFail': get(last, 'greenhouse_audit_events_total', action='login', outcome='fail'),
                  'httpByStatus': {st: total(last, 'greenhouse_http_request_seconds_count', status=st) for st in ('200', '401', '404')},
                  'clientHttp': ev['clients']['http']},
    'exposition': {'lines': len(sample), 'bytes': sum(len(l.encode()) + 1 for l in sample),
                   'series': sum(1 for l in sample if l and not l.startswith('#')),
                   'greenhouseSeries': sum(1 for l in sample if l.startswith('greenhouse_')),
                   'httpSeries': sum(1 for l in sample if l.startswith('greenhouse_http_request_seconds')),
                   'nodejsSeries': sum(1 for l in sample if l.startswith('nodejs_')),
                   'processSeries': sum(1 for l in sample if l.startswith('process_'))},
    'spray': events['spray-check'],
    'wholeRun': whole,
}
json.dump(summary, open(f'{OUT}/dashboard-summary.json', 'w'), ensure_ascii=False, indent=1)
s = summary
print(json.dumps({k: s[k] for k in ('steady', 'outage', 'reconcile', 'exposition')}, ensure_ascii=False, indent=1))
