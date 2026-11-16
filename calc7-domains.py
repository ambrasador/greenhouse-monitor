#!/usr/bin/env python3
"""Параметри спостереження для п’яти доменів (розділ 7, підрозділ 7.11).
Вихідні дані — таблиця навантаження доменів із розділу 1 (N, m, T), а також:
  * поріг мовчання NoReadings = 5·T (так заведено в alerts.rules.yml для теплиці, T = 60 с → 300 с);
  * крок збору метрик 15 с і крок обчислення правил 1 хв — навчальні припущення розділу 7.
Усе інше виводиться формулами:
  λ = N·m / T                       середня інтенсивність, 1/с;
  M = λ·5·T = 5·N·m                 показань, що мали б надійти за час мовчання до порогу;
  d_max = 5·T + t_eval + t_scrape   найгірша затримка сповіщення: поріг, крок правил, крок збору;
  S_gauge, S_hist                   розмір відповіді /metrics, якби gauge (78 байт) чи гістограма (769 байт) мали
                                    мітку «пристрій» (виміряно в calc7-cardinality.cjs; 100 000 для гістограми — розрахунок).
Результат — results/domains.json. Запуск: python3 calc7-domains.py"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get('CALC7_OUT', os.path.join(HERE, 'results'))
os.makedirs(OUT, exist_ok=True)

T_EVAL, T_SCRAPE = 60, 15                # с: крок обчислення правил (interval: 1m) і крок збору метрик
GAUGE_B, HIST_B = 78.0, 769.0            # байтів на пристрій (results/cardinality.json)
DOMAINS = [                              # назва, N, m, T — таблиця domains розділу 1
    ('Теплиця', 200, 4, 60),
    ('Розумний будинок', 3000, 1, 300),
    ('Облік комунальних послуг', 100000, 1, 900),
    ('Транспортний парк', 300, 1, 5),
    ('Інфраструктура громади', 1500, 1, 300),
]

rows = []
for name, n, m, t in DOMAINS:
    lam = n * m / t
    thr = 5 * t
    rows.append({
        'domain': name, 'N': n, 'm': m, 'T': t, 'lambda': round(lam, 1),
        'gapMean': 1 / lam,                       # середній інтервал між повідомленнями, с
        'threshold': thr,
        'missed': round(lam * thr),               # = 5·N·m
        'delayMax': thr + T_EVAL + T_SCRAPE,
        'delayVsT': (thr + T_EVAL + T_SCRAPE) / t,
        'gaugeBytes': round(n * GAUGE_B), 'histBytes': round(n * HIST_B),
    })
    assert rows[-1]['missed'] == 5 * n * m

json.dump({'tEval': T_EVAL, 'tScrape': T_SCRAPE, 'rows': rows}, open(os.path.join(OUT, 'domains.json'), 'w'),
          ensure_ascii=False, indent=1)
for r in rows:
    print(f"{r['domain']:<26} N={r['N']:>6} T={r['T']:>4} λ={r['lambda']:>6} 1/λ={r['gapMean']*1000:8.1f} мс "
          f"5T={r['threshold']:>5} M={r['missed']:>7} d_max={r['delayMax']:>5} ({r['delayVsT']:.2f} T)")
