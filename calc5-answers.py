"""Числа для відповідей до питань розділу 5, що рахуються формулами.
Питання 3 (кадри) і 9 (черга), а також повтори FCM (питання 7) перевірено запуском
коду еталона: tool/answers_check.dart і диспетчер push.js.
   python3 calc5-answers.py"""
import math
from statistics import NormalDist

N01 = NormalDist()
Q = lambda z: 1 - N01.cdf(z)          # хвіст стандартного нормального розподілу


def fmt(x, nd=2):
    return f'{x:,.{nd}f}'.replace(',', ' ').replace('.', ',')


print('== 1. Годинник')
shift, T_gh, T_fleet, T_util = 37, 60, 5, 900
print(f'теплиця: поріг {3*T_gh} с, картка сіріє при справжньому віці {3*T_gh - shift} с')
print(f'парк: поріг {3*T_fleet} с < зсув {shift} с: вік на телефоні ≥ {shift} с завжди')
eps = 0.5 + 0.3 / 2
print(f'ε = {eps} с;', {n: f'{100*eps/(3*t):.3f} %' for n, t in
                         [('теплиця', T_gh), ('парк', T_fleet), ('облік', T_util)]})

print('== 3. BLE')
for L in (500,):
    for mtu in (23, 185, 517):
        per = mtu - 3
        n = math.ceil((L + 2) / per)
        print(f'L={L} MTU={mtu}: n={n}, останній {L + 2 - (n - 1) * per} Б, {n*30} мс')
print('найменший MTU для одного запису: ', 500 + 2 + 3)
print('відношення записів 26:1')

print('== 4. Прив’язка')
for name, T in [('теплиця', 60), ('розумний будинок', 300), ('облік', 900), ('парк', 5), ('громада', 300)]:
    need = 8 + T
    print(f'{name}: T={T}: строк ≥ {need} с, вистачає 60 с: {need <= 60}')
print('опитувань 21, пауз 20; парк: connected на 9 с, claim на 9 (409), 12 (409), 15 (201)')

print('== 5. collapse')
pairs = 10 * 4 * 2
print(pairs, pairs / 4, len('gh1-s01:soil_moisture'.encode()))

print('== 6. Гістерезис CO2')
n = 86400 // 300
k_exact = N01.inv_cdf(1 - 1 / (n - 2))
k = math.ceil(k_exact * 100) / 100
sigma = 20
print(f'N={n}, k_exact={k_exact:.4f}, k={k}, h>={k*sigma:.1f} ppm, знімається при {1000-k*sigma:.0f} ppm')
for h in (40, k * sigma):
    z = h / sigma
    A = 1 + n / (2 + 1 / Q(z))
    print(f'h={h}: h/σ={z:.2f}, Q={Q(z):.6f}, A={A:.2f}')
print('для десяти повторів:', round(N01.inv_cdf(1 - 10 / n), 3))

print('== 8. Дублікати')
for Nn, q, m in [(500, 0.3, 10), (1000, 0.5, 10)]:
    R = Nn * (1 - q ** m) / (1 - q)
    print(f'N={Nn} q={q}: R={R:.2f}, зайвих {R-Nn:.1f} ({100*(R-Nn)/Nn:.1f} %), q^m={q**m:.3e}, непідтверджених {Nn*q**m:.3f}')

print('== 11. SSE')
for H in (15, 5):
    print(f'H={H}: idle у [{2*H}, {3*H}]')
print('відновлення: 40+3..6 =', 40 + 3, 40 + 6, '; 12+3..6 =', 12 + 3, 12 + 6)

print('== 12. Шари')
core, plat, ui, main = 1661, 94, 532, 127
tot = core + plat + ui + main
print(tot, plat + ui + main, round(100 * (plat + ui + main) / tot, 1), round(100 * core / tot, 1))
print('вектори', 433 + 301 + 96, round(100 * 433 / 830, 1))
print('Ahem 14 sp: літер у 45 dp', 45 // 14, '; ×2:', 45 // 28, '; 30 літер =', 30 * 14, 'dp')

print('== 13. Домен: теплиця з T = 120 с')
T = 120
rows = [900, 3600, 6 * 3600, 24 * 3600, 7 * 86400]
w = next(x for x in rows if x / T >= 60)
Nn = 86400 // T
kk = N01.inv_cdf(1 - 1 / (Nn - 2))
print(f'3T={3*T} с, крок={max(1, T//6)} с, лаг {100*max(1, T//6)/(3*T):.1f} %')
print(f'N={Nn}, k_exact={kk:.4f}, k={math.ceil(kk*100)/100}, h(σ=0,5)>={math.ceil(kk*100)/100*0.5:.2f} %')
print(f'вікно {w} с = {w/3600} год, точок {w//T}; 2000·T={2000*T} с = {2000*T/3600:.2f} год; 1000·T={1000*T} с = {1000*T/3600:.2f} год')
print('12 год ->', 12 * 3600 // T, 'подій; 40 год ->', 40 * 3600 // T, 'подій (> 1000)')
print('історії за reset: вікно', w // T, 'точок проти', 40 * 3600 // T)
