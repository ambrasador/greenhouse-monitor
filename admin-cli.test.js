'use strict';
// Команда retention: прибирання за строками зберігання з командного рядка
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const cli = (file, ...args) => spawnSync(process.execPath, [path.join(__dirname, 'admin-cli.js'), ...args],
  { env: { ...process.env, DB_FILE: file }, encoding: 'utf8' });

test('retention: видаляє лише записи старші за строк і друкує підсумок', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
  const file = path.join(dir, 'cli.db');
  try {
    assert.equal(cli(file, 'retention').stdout.trim(), '{"audit_log":0,"rejected":0,"push_tokens":0,"telemetry":0}');
    const db = new Database(file);
    const add = db.prepare('INSERT INTO rejected (received_at, reason) VALUES (?, ?)');
    add.run(new Date(Date.now() - 40 * 86_400_000).toISOString(), 'старий');
    add.run(new Date(Date.now() - 5 * 86_400_000).toISOString(), 'свіжий');
    db.close();
    assert.equal(JSON.parse(cli(file, 'retention').stdout).rejected, 1, 'за замовчуванням 30 діб');
    const left = new Database(file).prepare('SELECT reason FROM rejected').pluck().all();
    assert.deepEqual(left, ['свіжий']);
    assert.equal(JSON.parse(cli(file, 'retention', 'rejected=1').stdout).rejected, 1, 'строк можна змінити');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('retention: невідома таблиця або нульовий строк — помилка, а не мовчазне видалення всього', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
  try {
    for (const bad of ['users=1', 'rejected=0', 'rejected=-5', 'rejected=abc']) {
      const r = cli(path.join(dir, 'cli.db'), 'retention', bad);
      assert.equal(r.status, 1, bad);
      assert.match(r.stderr, /хибний строк/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('device-add: реєструє пристрій; повторна реєстрація й хибний id — помилка', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
  const file = path.join(dir, 'cli.db');
  try {
    assert.match(cli(file, 'device-add', 'gh1-s01', 'Грядка А', 'north').stdout, /зареєстровано gh1-s01/);
    const db = new Database(file);
    assert.deepEqual(db.prepare('SELECT device_id, name, zone FROM devices').all(),
      [{ device_id: 'gh1-s01', name: 'Грядка А', zone: 'north' }]);
    db.close();
    assert.equal(cli(file, 'device-add', 'gh1-s01', 'Дубль').status, 1);
    assert.equal(cli(file, 'device-add', 'bad id', 'Назва').status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('spray: багато різних імен із відмовою за вікно — код 1; старі записи й успішні входи не рахуються', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
  const file = path.join(dir, 'cli.db');
  try {
    assert.equal(cli(file, 'spray').status, 0, 'порожній журнал: тривоги немає');
    const db = new Database(file);
    const add = db.prepare(`INSERT INTO audit_log (ts, action, target, outcome, ip) VALUES (?, 'login', ?, ?, ?)`);
    const now = Date.now();
    for (let i = 0; i < 12; i++) add.run(new Date(now - 5_000).toISOString(), `user${i}`, 'fail', `10.0.0.${i}`);
    for (let i = 0; i < 20; i++) add.run(new Date(now - 600_000).toISOString(), `old${i}`, 'fail', '10.1.0.1');
    for (let i = 0; i < 20; i++) add.run(new Date(now - 5_000).toISOString(), `ok${i}`, 'ok', '10.2.0.1');
    db.close();
    const r = cli(file, 'spray');
    assert.equal(r.status, 1);
    assert.deepEqual(JSON.parse(r.stdout), { windowSec: 60, names: 12, addresses: 12, attempts: 12 });
    assert.equal(cli(file, 'spray', '60', '13').status, 0, 'поріг вище за кількість імен');
    assert.equal(JSON.parse(cli(file, 'spray', '900', '13').stdout).names, 32, 'у ширшому вікні видно й старі');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
