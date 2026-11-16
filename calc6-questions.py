#!/usr/bin/env python3
"""Відповіді до обчислювальних питань розділу 6 (питання 2-13). Усі вхідні числа взято з розділу
й вимірів M1-M10 (results/*.json); скрипт лише рахує. Запуск: python3 calc6-questions.py"""
import json, math, os

HERE = os.path.dirname(os.path.abspath(__file__))
C6 = os.path.join(HERE, 'results')
YEAR = 365.25 * 86400  # секунд у році (юліанський)

def load(name):
    with open(os.path.join(C6, name), encoding='utf8') as f:
        return json.load(f)

print('--- 2. scrypt N=2^16, r=8, p=2 (332,5 мс; 5,9 хеш/с)')
M = 128 * 2**16 * 8
print('M байтів', M, 'МіБ', M / 2**20, '; чотири хеші МіБ', 4 * M / 2**20)
t = 1e6 / 5.9
print('перебір 10^6 при 5,9/с: с', round(t), 'год', round(t / 3600, 1), 'діб', round(t / 86400, 2))

print('--- 3. шлюз хешування')
th = 0.223
lam = 2 / th
print('Λ =', lam, '; найдовше очікування Q=32:', 32 / lam)
for u in (2000, 5000):
    print('U =', u, 'с', u / lam)
# за мірою розділу: тривалість 2 000 / 8,98 ; частка 503 за 60 с = 1 - 60Λ/U
print('частка відхилених за 60 с (U=2000):', 1 - 60 * lam / 2000)

print('--- 4. ліміт за іменем і адресою')
b, r = 3, 1 / 120
A = b + r * 86400
print('A (b=3, r=1/120) =', A, '; діб для 10 000 паролів:', 10000 / A)
for u in (50, 5000):
    sec = 10 * u * 10
    print('розпилення 10 паролів проти', u, 'записів, 10 с на спробу:', sec, 'с =', sec / 60, 'хв =', sec / 86400, 'діб')

print('--- 5. токени')
for alg, tok, ver_us in (('HS256', 423, 9.8), ('RS256', 722, 51.0), ('ES256', 466, 95.0)):
    per = 22 + tok + 2
    print(alg, 'байтів на запит', per, 'МБ/с при 4 000', per * 4000 / 1e6, 'частка ядра %', 4000 * ver_us / 1e6 * 100)
print('RS256/HS256 за трафіком:', (22 + 722 + 2) / (22 + 423 + 2))

print('--- 6. refresh: строк 14 діб + 7 діб, 305 Б/рядок')
rows = (14 + 7) * 96
mib = rows * 305 / 2**20
print('рядків', rows, 'МіБ', mib, '; 5 000 екранів МіБ', 5000 * mib, 'ГіБ', 5000 * mib / 1024)
ex = 5000 / 900
print('обмінів/с', ex, 'частка ядра %', ex * 200e-6 * 100)

print('--- 7. матриця й область доступу')
print('комірок', 12 * 3, 'дозволено', 6 + 10 + 11, 'заборонено', 36 - 27)
print('запитів/с на ядро: 59,1 мс ->', 1 / 0.0591, '; 0,06 мс ->', 1 / 0.00006)

print('--- 8. відкликання й потоки')
print('перевірок за с: 2000/15 =', 2000 / 15, '; частка ядра % при 9 мкс:', 2000 / 15 * 9e-6 * 100)
print('потік відкрито 11:55:00 + 900 с -> 12:10:00; від 12:00:00 лишається', 900 - 300, 'с')

print('--- 9. вебхук')
print('1 000 відмов/с, 2 секрети, 16 КБ (16,1 мкс): частка ядра %', 1000 * 2 * 16.14e-6 * 100)
w = load('webhook.json')['replay']['bytesPerEntry']
ent = 60 * 900
print('записів', ent, 'МБ', ent * w / 1e6, '; пакети по 500: записів', ent / 500, 'байтів', ent / 500 * w)

print('--- 10. секрет з 10 символів [a-z0-9]')
g = load('webhook.json')['guessPerSec']
space = 36**10
sec = space / 2 / g
print('простір', space, 'середній час с', sec, 'років', sec / YEAR, '; GPU ×10^4: діб', sec / 1e4 / 86400)
print('символів для 128 біт:', 128 / math.log2(36), 'біт на символ', math.log2(36))

print('--- 11. код прив’язки 12 символів base32')
bits = 12 * 5
print('біт', bits)
tries = 5 + 86400 / 60
print('спроб за добу', tries, '; онлайн, середнє діб', 2**bits / 2 / tries, 'років', 2**bits / 2 / tries / 365.25)
sha = load('answers.json')['gate']['shaPerSec']
off = 2**bits / 2 / sha
print('офлайн SHA-256, 1 ядро: с', off, 'років', off / YEAR, '; ×10^4: років', off / YEAR / 1e4)
off80 = 2**80 / 2 / sha
print('для 80 біт: років', off80 / YEAR)

print('--- 12. приватність')
for city, lat in (('Львів', 49.8397),):
    ns = 111.19508 * 0.01
    ew = ns * math.cos(math.radians(lat))
    print(city, 'пн-пд км', ns, 'схід-захід км', ew, 'найбільша похибка км', 0.5 * math.hypot(ns, ew))
print('10 цифр SHA-256: с', 1e10 / sha, 'год', 1e10 / sha / 3600)
rows_day = 25 * 86400
batches = math.ceil(rows_day / 5000)
med = load('answers.json')['retention']['batchMedianMs']
print('λ=25: рядків/добу', rows_day, 'пакетів', batches, 'с', batches * med / 1000)

print('--- 13. журнал аудиту')
au = load('audit.json')
rec_us, row_b = au['recordUs']['median'], au['bytesPerRow']
rate = 300
print('300 відмов/с: частка ядра %', rate * rec_us / 1e6 * 100)
rd = rate * 86400
gb = rd * row_b / 1e9
print('рядків за добу', rd, 'ГБ за добу', gb, 'діб до 20 ГБ', 20 / gb)
agg = 3 * 2 * 1440
print('агрегація: рядків', agg, 'МБ за добу', agg * row_b / 1e6, 'зменшення у', rd / agg)
