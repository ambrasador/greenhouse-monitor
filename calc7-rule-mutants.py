#!/usr/bin/env python3
"""Мутації правил сповіщень (розділ 7, підрозділ 7.9): чи ловить promtool-набір ops/alerts.test.yml зламане правило.
Для кожної мутації копія каталогу ops/ отримує одну зміну в alerts.rules.yml, і `promtool test rules` має провалитися
саме на тесті відповідного сповіщення. Результат — results/rule-mutants.txt.
Запуск: python3 calc7-rule-mutants.py   (потрібні Docker і образ prom/prometheus:v3.16.0)"""
import os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get('CALC7_OUT', os.path.join(HERE, 'results'))
os.makedirs(OUT, exist_ok=True)
SRC = os.path.join(HERE, 'ops')
IMAGE = 'prom/prometheus:v3.16.0'
MUTANTS = [   # назва, що замінюємо, на що, сповіщення, чий тест має провалитися
    ('поріг IngestSlow 0,1 → 0,5 с', "sum by (le) (rate(greenhouse_ingest_seconds_bucket[5m]))) > 0.1",
     "sum by (le) (rate(greenhouse_ingest_seconds_bucket[5m]))) > 0.5", 'IngestSlow'),
    ('квантиль IngestSlow 0,95 → 0,99', 'histogram_quantile(0.95,', 'histogram_quantile(0.99,', 'IngestSlow'),
    ('поріг WebhookRejectedSpike 20 → 100', 'outcome="rejected"}[5m]) > 20', 'outcome="rejected"}[5m]) > 100',
     'WebhookRejectedSpike'),
    ('PushAlertLost без результату expired', 'result=~"expired|gave_up|invalid|config"', 'result=~"gave_up|invalid|config"',
     'PushAlertLost'),
    ('поріг ApiBudgetTicket 0,001 → 0,01', 'greenhouse:http_errors:ratio_rate3d > 0.001',
     'greenhouse:http_errors:ratio_rate3d > 0.01', 'ApiBudgetTicket'),
    ('поріг NoReadings 300 → 900 с', '{__name__=~"(greenhouse_last_reading_timestamp|process_start_time)_seconds"}\n          ) > 300',
     '{__name__=~"(greenhouse_last_reading_timestamp|process_start_time)_seconds"}\n          ) > 900', 'NoReadings'),
    ('BrokerDisconnected без for: 2m', 'expr: greenhouse_broker_connected == 0\n        for: 2m',
     'expr: greenhouse_broker_connected == 0', 'BrokerDisconnected'),
    ('швидке вікно ApiBudgetFastBurn 14,4 → 144', 'greenhouse:http_errors:ratio_rate1h > 14.4 * 0.001',
     'greenhouse:http_errors:ratio_rate1h > 144 * 0.001', 'ApiBudgetFastBurn'),
]
lines, caught = [], 0
for name, old, new, alert in MUTANTS:
    d = tempfile.mkdtemp(prefix='mut.')
    os.chmod(d, 0o755)
    try:
        for f in os.listdir(SRC):
            shutil.copy(os.path.join(SRC, f), d)
        path = os.path.join(d, 'alerts.rules.yml')
        text = open(path, encoding='utf8').read()
        assert text.count(old) == 1, (name, text.count(old))
        open(path, 'w', encoding='utf8').write(text.replace(old, new))
        for f in os.listdir(d):
            os.chmod(os.path.join(d, f), 0o644)
        r = subprocess.run(['docker', 'run', '--rm', '-v', f'{d}:/ops', '--entrypoint', 'promtool', IMAGE,
                            'test', 'rules', '/ops/alerts.test.yml'], capture_output=True, text=True)
        out = r.stdout + r.stderr
        ok = r.returncode != 0 and f'alertname: {alert}' in out
        caught += ok
        lines.append(f"{'спіймано' if ok else 'ПРОПУЩЕНО'}  {name}  (rc={r.returncode})")
    finally:
        shutil.rmtree(d, ignore_errors=True)
lines.append(f'спіймано {caught} з {len(MUTANTS)}')
open(os.path.join(OUT, 'rule-mutants.txt'), 'w', encoding='utf8').write('\n'.join(lines) + '\n')
print('\n'.join(lines))
sys.exit(0 if caught == len(MUTANTS) else 1)
