#!/usr/bin/env python3
"""Відповіді до обчислювальних питань розділу 7 (питання 1–11 і 13; питання 12 — проєктне, обчислень не потребує).
Вхідні числа — з таблиць розділу (їх значення виписано тут як константи з посиланням на таблицю) і з вимірів M1–M12
(dashboard-summary.json, cardinality.json, deploy-downtime.json, ci-stages.json, overhead.json у каталозі результатів);
скрипт лише рахує. Результат — results/questions.json і друк у стандартний вивід.
Запуск із каталогу проєкту: python3 calc7-questions.py"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
C7 = os.environ.get('CALC7_OUT', os.path.join(HERE, 'results'))
os.makedirs(C7, exist_ok=True)
R = {}


BOOK = os.path.join(HERE, 'results', 'book')          # в архіві коду: виміри, опубліковані в підручнику (ch7-*)


def load(name):
    """Вимір із каталогу результатів; якщо кроку ще не виконано (скажімо, немає Docker), — файл ch7-<name> із підручника."""
    path = os.path.join(C7, name)
    if not os.path.exists(path):
        path = os.path.join(BOOK, 'ch7-' + name)
        print(f'{name}: свіжого виміру немає, взято {os.path.relpath(path, HERE)}')
    with open(path, encoding='utf8') as f:
        return json.load(f)


def pct(x, nd=1):
    return round(100 * x, nd)


# --- 1. Піраміда (таблиця d7cost, підрозділ 7.1.1) ---------------------------------------------------------------
levels = {'unit': (21, 121, 3.2), 'db': (10, 54, 3.9), 'net': (16, 170, 17.2)}   # файлів, тестів, час, с
TESTS, TIME, START = 345, 24.3, 0.029                                             # разом; запуск Node.js, с
R['q1'] = {
    'testShare': {k: pct(v[1] / TESTS) for k, v in levels.items()},
    'timeShare': {k: pct(v[2] / TIME) for k, v in levels.items()},
    'startMs': {k: round(v[0] * START * 1000) for k, v in levels.items()},
    'startShare': {k: pct(v[0] * START / v[2]) for k, v in levels.items()},
    'e2eOverUnit': round(836 / 27, 1), 'killOverUnit': round(1600 / 27, 1),
    'startPerTestNetMs': round(16 * START * 1000 / 170, 1),
}

# --- 2. Мутанти й покриття (таблиці d7mut, d7cov, підрозділи 7.2.2–7.2.3) ------------------------------------------
unit_ms, integ_ms = 250 / 18, 2600 / 5                                           # 0,25 с / 18 тестів; 2,6 с / 5 тестів
R['q2'] = {
    'killed': {'jest16': pct(7 / 9), 'jest18': pct(9 / 9), 'node': pct(6 / 9)},
    'marginLines': round(92.6 - 85, 1), 'marginBranches': round(79.1 - 70, 1),
    'msUnit': round(unit_ms, 1), 'msInteg': round(integ_ms), 'ratio': round(integ_ms / unit_ms, 1),
}

# --- 3. Очікування умови й пауза (таблиця d7flaky, підрозділ 7.3.5) -----------------------------------------------
N3 = 1500
over5 = {'idle': 1, 'load': 78}
over10 = {'idle': 0, 'load': 1}
p5 = over5['load'] / N3
R['q3'] = {
    'over5': {k: pct(v / N3, 3) for k, v in over5.items()},
    'over10': {k: pct(v / N3, 3) for k, v in over10.items()},
    'enough5': {k: pct(1 - v / N3, 2) for k, v in over5.items()},
    'expectedFail300': round(300 * p5, 1),
    'sigmaFail300': round(math.sqrt(300 * p5 * (1 - p5)), 1),
    'sleep300Total': 170 * 0.3, 'sleep300Ratio': round(170 * 0.3 / 17.2, 2),
    'waitForVs20': 3000 / 20, 'waitForVsMax': round(3000 / 12.48, 1),
}

# --- 4. Нестабільний тест (таблиця d7flake, підрозділ 7.4.3) -----------------------------------------------------
p = 1 / 16


def n_detect(q, conf=0.95):
    return math.log(1 - conf) / math.log(1 - q)


MODEL_N, MODEL_FAIL = 3000, 181
mu, sd = MODEL_N * p, math.sqrt(MODEL_N * p * (1 - p))
per_file = 228.6 / 400
R['q4'] = {
    'n': {str(q): round(n_detect(q), 1) for q in (p, 0.02, 0.01)},
    'nCeil': {str(q): math.ceil(n_detect(q)) for q in (p, 0.02, 0.01)},
    'mu': mu, 'sigma': round(sd, 2), 'z': round((MODEL_FAIL - mu) / sd, 2),
    'retry3': p ** 3, 'retry3Pct': round(100 * p ** 3, 3), 'greenOf4096': 4096 - 1,
    'perFileSec': round(per_file, 3), 'file47Sec': round(47 * per_file, 1),
    'suite47Sec': round(47 * 24.3, 1), 'suite47Min': round(47 * 24.3 / 60, 1),
}

# --- 5. Образ, кеш збирання, перезапуск, проба (таблиці d7image, d7build, d7restart; підрозділи 7.5.1–7.5.4) -----------
pauses, d = [], 0.1
for _ in range(12):
    pauses.append(round(min(d, 60.0), 1))
    d *= 2
cap_from = next(i + 1 for i, v in enumerate(pauses) if v >= 60.0)
t, starts, run = 0.0, 0, 0.4
while t <= 300:                                  # запуск рахуємо, якщо він почався не пізніше 300 с
    starts += 1
    t += run + min(0.1 * 2 ** (starts - 1), 60.0)
R['q5'] = {
    'disk': round(854 / 410, 2), 'registry': round(205 / 97.4, 2), 'context': round(68.65 / 0.47),
    'cacheCode': pct((17.4 - 0.9) / 17.4), 'cacheManifest': pct((17.4 - 14.4) / 17.4), 'cacheFull': pct((17.4 - 0.7) / 17.4),
    'pauses': pauses, 'capFrom': cap_from, 'sum10': round(sum(pauses[:10]), 1), 'starts5min': starts,
    'start14At': round(sum(run + min(0.1 * 2 ** (k - 1), 60.0) for k in range(1, 14)), 1),
    'unhealthyMin': 2 * 15, 'unhealthyMax': 3 * 15,
}

# --- 6. Конвеєр (таблиця d7cistages, підрозділ 7.6.1; ci-stages.json) --------------------------------------------
ci = load('ci-stages.json')
J = ci['jobSecondsWithInstall']
lint, test, e2e, image = J['lint'], J['test'], J['e2e'], J['image']
R['q6'] = {
    'critical': round(lint + max(test, e2e) + image, 1), 'sum': round(lint + test + e2e + image, 1),
    'oneJob': ci['sequentialSeconds'], 'gain': round(ci['sequentialSeconds'] - (lint + max(test, e2e) + image), 1),
    'gainPct': pct((ci['sequentialSeconds'] - (lint + max(test, e2e) + image)) / ci['sequentialSeconds']),
    'extraWork': round(lint + test + e2e + image - ci['sequentialSeconds'], 1),
    'hiddenByParallel': e2e,
    'critical45': round(lint + max(test, 45) + image, 1), 'sum45': round(lint + test + 45 + image, 1),
    'npmCi': ci['stages'][1]['seconds'], 'npmCiRange': [ci['stages'][1]['min'], ci['stages'][1]['max']],
}

# --- 7. Оновлення й бюджет помилок (deploy-downtime.json, підрозділи 7.7.2 і 7.9.1) ------------------------------
dep = load('deploy-downtime.json')[0]
bad = dep['codes']['502'] + dep['codes']['0']
budget_s = 30 * 86400 * 0.001
R['q7'] = {
    'probes': dep['probeCount'], 'bad': bad, 'badPct': pct(bad / dep['probeCount']), 'outage': dep['outageSeconds'],
    'budgetSec': round(budget_s, 1), 'budgetMin': round(budget_s / 60, 1),
    'sharePerDeploy': round(100 * dep['outageSeconds'] / budget_s, 3),
    'deploysToExhaust': round(budget_s / dep['outageSeconds']), 'perDay': round(budget_s / dep['outageSeconds'] / 30, 1),
    'tenPerDaySec': round(10 * 30 * dep['outageSeconds'], 1), 'tenPerDayPct': pct(10 * 30 * dep['outageSeconds'] / budget_s),
}

# --- 8. Журнал (overhead.json «log», підрозділ 7.8.1) ------------------------------------------------------------
lg = load('overhead.json')['log']
R['q8'] = {
    'linesPerDay': 86400 // 2,
    'usRedact': round(lg['pinoRedactUs'], 2), 'usPlain': round(lg['pinoUs'], 2), 'usStringify': round(lg['stringifyWriteUs'], 2),
    'msPer1000lines': {k: round(v, 2) for k, v in (('redact', lg['pinoRedactUs']), ('plain', lg['pinoUs']), ('stringify', lg['stringifyWriteUs']))},
    'corePct': {k: round(1000 * v / 1e6 * 100, 2) for k, v in (('redact', lg['pinoRedactUs']), ('plain', lg['pinoUs']), ('stringify', lg['stringifyWriteUs']))},
    'rateFor10pct': round(0.10 / (lg['pinoRedactUs'] * 1e-6)),
    'hidden': 4, 'visible': 3,
}

# --- 9. Квантилі за кошиками (dashboard-summary.json, підрозділ 7.8.2) ---------------------------------------------
run_data = load('dashboard-summary.json')['wholeRun']
BOUNDS = [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1]


def quantile(cum, q):
    """histogram_quantile: лінійна інтерполяція всередині кошика, де лежить ранг q·total."""
    total = cum[-1]
    rank = q * total
    lo_b, lo_c = 0.0, 0
    for ub, c in zip(BOUNDS, cum):
        if c >= rank:
            return lo_b + (ub - lo_b) * (rank - lo_c) / (c - lo_c), rank
        lo_b, lo_c = ub, c
    raise ValueError(q)


worst = [run_data['worstWindowBuckets'][str(b)] for b in BOUNDS]
whole = [run_data['bucketsCumulative'][str(b)] for b in BOUNDS]
worst = [int(x) for x in worst]
whole = [int(x) for x in whole]
q50w, r50w = quantile(worst, 0.5)
q95w, r95w = quantile(worst, 0.95)
q99w, r99w = quantile(worst, 0.99)
q99all, r99all = quantile(whole, 0.99)
R['q9'] = {
    'worstCum': worst, 'wholeCum': whole,
    'worst': {'p50ms': round(q50w * 1000, 3), 'rank50': round(r50w, 2), 'p95ms': round(q95w * 1000, 2), 'rank95': round(r95w, 2),
              'p99ms': round(q99w * 1000, 1), 'rank99': round(r99w, 2)},
    'whole': {'p99ms': round(q99all * 1000, 2), 'rank99': round(r99all, 2)},
    'meanOfWindowsP99ms': round(run_data['p99MeanOfWindows'], 2), 'meanWithoutWorstMs': round(run_data['p99MeanWithoutWorst'], 2),
    'weight': round(1 / 43, 4), 'shiftMs': round((q99w * 1000 - run_data['p99MeanWithoutWorst']) / 43, 2),
}

# --- 10. Кардинальність (cardinality.json, підрозділ 7.8.4) -------------------------------------------------------
card = load('cardinality.json')
G, H = 78.0, 769.0
real_bytes = 17966
R['q10'] = {
    'fleetGaugeBytes': round(300 * G), 'fleetHistLines': 300 * 12, 'fleetHistBytes': round(300 * H),
    'meterGaugeBytes': round(100000 * G), 'meterMBs': round(100000 * G / 15 / 1e6, 3), 'meterMbit': round(100000 * G / 15 * 8 / 1e6, 2),
    'meterVsReal': round(card['gauge'][-1]['bytes'] / real_bytes), 'meterBuildMs': round(card['gauge'][-1]['buildMs']),
    'meterCorePct': round(card['gauge'][-1]['buildMs'] / 1000 / 15 * 100, 2),
    'meterHistMB': round(100000 * H / 1e6, 1),
}

# --- 11. Бюджет помилок (таблиця d7burn, підрозділ 7.9.1) --------------------------------------------------------
b1, b2 = 0.001, 1 - 0.9995
e = 0.005
pairs = [(14.4, 60), (6, 360), (1, 4320)]                                         # (швидкість k, довге вікно W, хв)
R['q11'] = {
    'b2': round(b2, 6), 'budgetMin2': round(30 * 1440 * b2, 1),
    'thr2': [round(100 * k * b2, 3) for k, _ in pairs],
    'thr1': [round(100 * k * b1, 3) for k, _ in pairs],
    'e': e, 'burnRate': round(e / b1, 1),
    'fastFires': e > 14.4 * b1, 'slowFires': e > 6 * b1, 'ticketFires': e > 1 * b1,
    'ticketMin': round(1 * b1 * 4320 / e), 'ticketHours': round(1 * b1 * 4320 / e / 60, 1),
    'ticketSharePct': pct(1 * 4320 / 43200),
    'budgetSharePct': pct((e / b1) * (1 * b1 * 4320 / e / 60) / 720),
    'fastThresholdPct': round(100 * 14.4 * b1, 2), 'fastMinInWindow': round(14.4 * b1 * 60, 3),
}
R['q11']['hang'] = round(60 - R['q11']['fastMinInWindow'], 1)         # 59,1 хв: від кінця відмови до зникнення її з годинного вікна

# --- 13. Власний домен і правила підрозділу 7.11 (таблиця d7domains) ---------------------------------------------
n_, m_, T_ = 800, 2, 120
T_EVAL, T_SCRAPE = 60, 15
lam_meter = 100000 * 1 / 900
R['q13'] = {
    'lambda': round(n_ * m_ / T_, 1), 'threshold': 5 * T_, 'M': 5 * n_ * m_, 'dmax': 5 * T_ + T_EVAL + T_SCRAPE,
    'dmaxMin': round((5 * T_ + T_EVAL + T_SCRAPE) / 60, 2), 'dmaxT': round((5 * T_ + T_EVAL + T_SCRAPE) / T_, 2),
    'fleetTuned': 25 + 15 + 5, 'fleetTunedT': round((25 + 15 + 5) / 5, 1), 'fleetEvalRatio': 60 // 15,
    'sigmaRateMeter': round(lam_meter * 0.0027, 2), 'sigmaPerHourMeter': round(lam_meter * 0.0027 * 3600),
    'sigmaPerHourGreenhouse': round(200 * 4 / 60 * 0.0027 * 3600),
    'scatteredRate': round(40000 / 900, 1), 'scatteredAgeMs': round(1000 * 900 / 40000, 1),
}

json.dump(R, open(os.path.join(C7, 'questions.json'), 'w'), ensure_ascii=False, indent=1)
for k in sorted(R, key=lambda s: int(s[1:])):
    print('---', k)
    for name, val in R[k].items():
        print(f'  {name}: {val}')
