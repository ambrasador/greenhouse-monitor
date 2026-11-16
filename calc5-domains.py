"""M13: параметри мобільного клієнта для п’яти доменів (розділ 5.9).

Усе виводиться з періоду звітування T. Постійні — з коду еталона:
  maxChartPoints = 2000 (lib/core/domain.dart), replayLimit = 1000 (proj/sse.js),
  статус «Немає даних» через 3·T, ε <= 0,5 с + RTT/2 (формула d5err).
Навчальні припущення (позначені в тексті): RTT = 1 с, поріг «видно хід» = 60 точок,
набір «круглих» вікон, швидкість 90 км/год.

   python3 calc5-domains.py [out.json]
"""
import json
import math
import sys
from statistics import NormalDist

import numpy as np

CAP = 2000              # maxChartPoints
REPLAY = 1000           # replayLimit сервера, рядків
RTT = 1.0               # с, припущення
EPS = 0.5 + RTT / 2     # с, формула d5err
MIN_POINTS = 60         # навчальний поріг: на графіку видно хід
ROUND = [15 * 60, 3600, 6 * 3600, 24 * 3600, 7 * 86400]
DAY = 86400

DOMAINS = [
    ('Теплиця', 60),
    ('Розумний будинок', 300),
    ('Облік комунальних послуг', 900),
    ('Транспортний парк', 5),
    ('Інфраструктура громади', 300),
]


def fmt(sec):
    """Тривалість словами: 16 год 40 хв, 3 хв, 15 с."""
    sec = round(sec)
    h, rest = divmod(sec, 3600)
    m, s = divmod(rest, 60)
    parts = []
    if h:
        parts.append(f'{h:,} год'.replace(',', ' '))
    if m:
        parts.append(f'{m} хв')
    if s:
        parts.append(f'{s} с')
    return ' '.join(parts) if parts else '0 с'


def pick_window(period):
    """Найкоротше «кругле» вікно, у якому не менше MIN_POINTS точок."""
    return next(w for w in ROUND if w / period >= MIN_POINTS)


def multiplier(period):
    """k = h/σ, за якого повторних сповіщень не більше одного на добу.
    Формула d5alerts: A = 1 + N / (2 + 1/Q); A - 1 <= 1  =>  Q <= 1 / (N - 2)."""
    n = DAY / period
    return NormalDist().inv_cdf(1 - 1 / (n - 2))


def simulate(period, k, days=400, seed=5):
    """Автомат із двома станами; середнє значення на порозі, шум N(0, 1).
    З норми — у тривогу при v < 0, назад — при v >= k. Повертає середнє A за добу."""
    n = int(DAY / period)
    rng = np.random.default_rng(seed)
    alarm = np.zeros(days, dtype=bool)
    count = np.zeros(days, dtype=np.int64)
    for _ in range(n):
        v = rng.standard_normal(days)
        fire = ~alarm & (v < 0)
        count += fire
        alarm = np.where(fire, True, np.where(alarm & (v >= k), False, alarm))
    return float(count.mean())


rows = []
for name, t in DOMAINS:
    w = pick_window(t)
    k = multiplier(t)
    rows.append({
        'domain': name,
        'T': t,
        'stale_s': 3 * t,
        'stale': fmt(3 * t),
        'tick_s': max(1, t // 6),                      # statusTick у domain.dart
        'tick_lag_pct': round(100 * max(1, t // 6) / (3 * t), 2),
        'eps_share_pct': round(100 * EPS / (3 * t), 2),
        'per_hour': 3600 // t,
        'per_day': DAY // t,
        'k_exact': round(k, 4),
        'k': math.ceil(k * 100) / 100,  # нижня межа: округлено вгору
        'k_alerts_sim': round(simulate(t, k), 2),
        'window_s': w,
        'window': fmt(w),
        'points': w // t,
        'max_window_s': CAP * t,
        'max_window': fmt(CAP * t),
        'replay_s': REPLAY * t,
        'replay': fmt(REPLAY * t),
    })

# Дані для тексту
month_s = 30 * DAY
extra = {
    'greenhouse_temperature_window_s': 6 * 3600,
    'greenhouse_temperature_points': 6 * 3600 // 60,
    'utilities_month_points': month_s // 900,
    'utilities_month_over_cap': month_s // 900 - CAP,
    'utilities_max_days': CAP * 900 / DAY,
    'utilities_daily_buckets': 30,
    'utilities_hourly_buckets': month_s // 3600,
    'smart_pause_fri18_mon09_h': 63,
    'smart_pause_events': 63 * 3600 // 300,
    'fleet_speed_ms': 90 / 3.6,
    'fleet_stale_m': 3 * 5 * 90 / 3.6,
    'fleet_offline_5min_km': 300 * 90 / 3.6 / 1000,
    'fleet_watchdog_recovery_s': [43, 46],
    'phone_pause_3h_events_greenhouse': 3 * 3600 // 60,
    'eps_s': EPS,
}

out = {'rows': rows, 'extra': extra,
       'assumptions': {'rtt_s': RTT, 'min_points': MIN_POINTS, 'round_windows_s': ROUND}}

print(f'ε = 0,5 + RTT/2 = {EPS} с при RTT = {RTT} с')
print(f'{"Домен":28} {"T":>4} {"3T":>8} {"крок":>5} {"лаг,%":>6} {"ε/3T,%":>7} {"за добу":>8} {"k":>5} '
      f'{"A (сим.)":>8} {"вікно":>8} {"N":>4} {"2000·T":>14} {"1000·T":>12}')
for r in rows:
    print(f'{r["domain"]:28} {r["T"]:>4} {r["stale"]:>8} {r["tick_s"]:>5} {r["tick_lag_pct"]:>6} {r["eps_share_pct"]:>7} '
          f'{r["per_day"]:>8} {r["k"]:>5} {r["k_alerts_sim"]:>8} {r["window"]:>8} '
          f'{r["points"]:>4} {r["max_window"]:>14} {r["replay"]:>12}')
for k, v in extra.items():
    print(f'{k} = {v}')

if len(sys.argv) > 1:
    with open(sys.argv[1], 'w', encoding='utf8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
