'use strict';

const assert = require('assert');
const { DateTime } = require('luxon');
const { shouldSendNow, escapeForScriptContext } = require('../index');

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`fail - ${name}`);
    throw err;
  }
}

const wib = (iso) => DateTime.fromISO(iso, { zone: 'Asia/Jakarta' });

test('shouldSendNow tetap mengirim di dalam jendela hangus', () => {
  const now = wib('2026-09-26T10:05:00');
  assert.strictEqual(shouldSendNow('10:00', now), true);
});

test('shouldSendNow menolak pengingat yang terlewat terlalu lama', () => {
  const now = wib('2026-09-26T12:00:00');
  assert.strictEqual(shouldSendNow('10:00', now), false);
  assert.strictEqual(shouldSendNow('07:00', now), false);
});

test('shouldSendNow masih menolak jadwal yang belum tiba', () => {
  const now = wib('2026-09-26T10:00:00');
  assert.strictEqual(shouldSendNow('19:30', now), false);
});

test('shouldSendNow tidak melempar untuk masukan kosong', () => {
  const now = wib('2026-09-26T10:00:00');
  assert.strictEqual(shouldSendNow(null, now), false);
  assert.strictEqual(shouldSendNow('bukan jam', now), false);
});

test('escapeForScriptContext menutup celah tag script', () => {
  const payload = '</script><script>alert(1)</script>';
  const escaped = escapeForScriptContext(payload);
  assert.ok(!escaped.includes('<'), 'tidak boleh ada tanda kurung sudut');
  assert.ok(!escaped.includes('>'), 'tidak boleh ada tanda kurung sudut');
  assert.ok(escaped.includes('\\u003c'), 'tag pembuka harus di-escape');
  assert.ok(escaped.startsWith('"') && escaped.endsWith('"'), 'tetap literal string');
});

test('escapeForScriptContext tidak mengubah nilai normal', () => {
  const waId = '628123456789@c.us';
  assert.strictEqual(escapeForScriptContext(waId), JSON.stringify(waId));
  const numeric = '120363199418290866@newsletter';
  assert.strictEqual(escapeForScriptContext(numeric), JSON.stringify(numeric));
});

test('escapeForScriptContext menangani ampersand dan nilai kosong', () => {
  assert.ok(!escapeForScriptContext('a&b').includes('&'));
  assert.strictEqual(escapeForScriptContext(''), '""');
  assert.strictEqual(escapeForScriptContext(null), '""');
});