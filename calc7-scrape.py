#!/usr/bin/env python3
"""Ціна одного опитування /metrics працюючого сервера (розділ 7, підрозділ 7.8.4).
Запускається на стеку Compose, який щойно відпрацював сценарій спостережуваності (calc7-dashboard.py): реєстр
містить усі ряди сценарію. У контейнері backend скрипт робить 20 пробних і 300 вимірюваних запитів
GET http://127.0.0.1:3000/metrics підряд, міряє час відповіді разом із читанням тіла, а процесорний час сервера
бере з його власних лічильників process_cpu_*_seconds_total до і після серії.
Результат — results/scrape-real.json. Запуск: python3 calc7-scrape.py   (потрібні Docker і запущений стек)"""
import json, os, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get('CALC7_OUT', os.path.join(HERE, 'results'))
os.chdir(HERE)
os.makedirs(OUT, exist_ok=True)

JS = r"""
const url = 'http://127.0.0.1:3000/metrics', N = 300;
const cpu = (t) => ['process_cpu_user_seconds_total', 'process_cpu_system_seconds_total']
  .reduce((s, n) => s + Number(new RegExp('^' + n + ' (\\S+)', 'm').exec(t)[1]), 0);
(async () => {
  const get = async () => (await fetch(url)).text();
  for (let i = 0; i < 20; i++) await get();
  const before = cpu(await get());
  const times = []; let text = '';
  for (let i = 0; i < N; i++) {
    const t0 = performance.now(); text = await get(); times.push(performance.now() - t0);
  }
  const after = cpu(await get());
  times.sort((a, b) => a - b);
  const lines = text.split('\n').filter(Boolean);
  console.log(JSON.stringify({
    requests: N, bytes: Buffer.byteLength(text), lines: lines.length,
    series: lines.filter((l) => !l.startsWith('#')).length,
    medianMs: times[N >> 1], p99Ms: times[Math.floor(N * 0.99)], maxMs: times[N - 1],
    serverCpuMsPerRequest: (after - before) / (N + 1) * 1000,
  }));
})();
"""
r = subprocess.run(['docker', 'compose', 'exec', '-T', 'backend', 'node', '-e', JS],
                   capture_output=True, text=True, check=True)
res = json.loads(r.stdout)
json.dump(res, open(os.path.join(OUT, 'scrape-real.json'), 'w'), ensure_ascii=False, indent=1)
print(json.dumps(res, ensure_ascii=False, indent=1))
