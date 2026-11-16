'use strict';
// Вимір M2 (частина): чи справді тести перевіряють межі. У копії проєкту по одному вносяться типові
// помилки в пороги й гістерезис (мутанти), і для кожної фіксується, чи падає хоч один тест:
// модульні тести Jest, тести node:test тих самих модулів, інтеграційні Jest.
// Результат: results/mutants.json. Запуск: node calc7-mutants.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'results', 'mutants.json');

// [ідентифікатор, файл, що замінюємо, на що, опис]
const MUTANTS = [
  ['m1', 'push.js', 'lt ? v < limit : v > limit', 'lt ? v <= limit : v >= limit',
    'nextLevel: поріг порушення включено (< → <=)'],
  ['m2', 'push.js', 'lt ? v >= limit + r.hysteresis : v <= limit - r.hysteresis',
    'lt ? v > limit + r.hysteresis : v < limit - r.hysteresis',
    'nextLevel: вихід із рівня строгий (>= → >)'],
  ['m3', 'push.js', 'lt ? v >= limit + r.hysteresis : v <= limit - r.hysteresis',
    'lt ? v >= limit : v <= limit', 'nextLevel: гістерезис вилучено'],
  ['m4', 'push.js', "  if (cur === 'critical' && !clear(r.crit)) return 'critical';\n", '',
    'nextLevel: критичний рівень не утримується гістерезисом'],
  ['m5', 'push.js', "if (cur !== 'normal' && !clear(r.warn)) return 'warning';",
    "if (cur === 'warning' && !clear(r.warn)) return 'warning';",
    'nextLevel: із критичного відразу в нормальний'],
  ['m6', 'alerts.js', 'if (cur.durationMs >= minDurationMs)', 'if (cur.durationMs > minDurationMs)',
    'findViolations: епізод рівно мінімальної тривалості відкидається (>= → >)'],
  ['m7', 'alerts.js', 'ms - prev > maxGapMs', 'ms - prev >= maxGapMs',
    'findViolations: розрив рівно в межу закриває епізод (> → >=)'],
  ['m8', 'alerts.js', '(lt ? v >= threshold + hysteresis : v <= threshold - hysteresis)',
    '(lt ? v > threshold + hysteresis : v < threshold - hysteresis)',
    'findViolations: вихід із епізоду строгий (>= → >)'],
  ['m9', 'alerts.js', 'const worst = lt ? Math.min : Math.max;', 'const worst = lt ? Math.max : Math.min;',
    'findViolations: найгірше значення епізоду береться навпаки'],
];
function copyProject(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(ROOT)) {
    if (/\.(js|cjs|mjs|sql|json)$/.test(f) && f !== 'package-lock.json') fs.copyFileSync(path.join(ROOT, f), path.join(dest, f));
  }
  fs.cpSync(path.join(ROOT, 'jest'), path.join(dest, 'jest'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'migrations'), path.join(dest, 'migrations'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'client'), path.join(dest, 'client'), { recursive: true, filter: (s) => !s.includes('dist') });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dest, 'node_modules'));
}

const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};
const jestFailed = (out) => Number((out.match(/Tests:\s+(?:(\d+) failed, )?/) ?? [])[1] ?? 0);
const nodeFailed = (out) => Number((out.match(/^# fail (\d+)/m) ?? [])[1] ?? 0);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mut-'));
const W = path.join(dir, 'p');
copyProject(W);
const JEST = ['--experimental-vm-modules', 'node_modules/jest/bin/jest.js'];
const baseline = {
  jestUnit: jestFailed(run('node', [...JEST, '--selectProjects', 'unit'], W).out),
  jestIntegration: jestFailed(run('node', [...JEST, '--selectProjects', 'integration'], W).out),
  nodeTest: nodeFailed(run('node', ['--test', '--test-reporter=tap', 'alerts.test.js', 'push.test.js'], W).out),
};
console.log('базова лінія (падінь має бути 0):', JSON.stringify(baseline));
const rows = [];
for (const [id, file, from, to, what] of MUTANTS) {
  const p = path.join(W, file);
  const original = fs.readFileSync(p, 'utf8');
  if (original.split(from).length !== 2) { console.error('мутацію не застосовано', id); process.exit(1); }
  fs.writeFileSync(p, original.replace(from, () => to));
  const ju = run('node', [...JEST, '--selectProjects', 'unit'], W);
  const nt = run('node', ['--test', '--test-reporter=tap', 'alerts.test.js', 'push.test.js'], W);
  fs.writeFileSync(p, original);
  const row = { id, file, what, jestUnitFailed: jestFailed(ju.out), jestUnitKilled: ju.code !== 0,
    nodeTestFailed: nodeFailed(nt.out), nodeTestKilled: nt.code !== 0 };
  rows.push(row);
  console.log(id, JSON.stringify(row));
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ host: `${os.cpus()[0].model}, ${os.cpus().length} vCPU, Node ${process.version}`,
  baseline, mutants: rows }, null, 1));
fs.rmSync(dir, { recursive: true, force: true });
