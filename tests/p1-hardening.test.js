'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const {
  validateEnv,
  takeSendAttempt,
  checkAdminLoginAllowed,
  registerAdminLoginFailure,
  clearAdminLoginFailures,
  checkDbIntegrity,
  ensureSettingsTable,
  getSetting,
  setSetting,
} = require('../index');
const { parseEnvContent, loadEnvFile } = require('../lib/env-file');
const { createSendGuard } = require('../lib/send-guard');

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`fail - ${name}`);
    throw err;
  }
}

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-p1-'));
  const file = path.join(dir, 'test.db');
  const db = new sqlite3.Database(file);
  return { dir, file, db };
}

async function main() {
  await test('validateEnv menerima angka dan mengabaikan env kosong', () => {
    assert.deepStrictEqual(validateEnv({ SEND_MAX_PER_MINUTE: '12' }), []);
    assert.deepStrictEqual(validateEnv({ SEND_MAX_PER_MINUTE: '' }), []);
    assert.deepStrictEqual(validateEnv({}), []);
  });

  await test('validateEnv menolak nilai yang bukan angka', () => {
    const invalid = validateEnv({ SEND_MAX_PER_MINUTE: 'abc', ADMIN_WEB_PORT: '3o3o' });
    assert.strictEqual(invalid.length, 2);
    assert.ok(invalid.some((item) => item.startsWith('SEND_MAX_PER_MINUTE="abc"')));
    assert.ok(invalid.some((item) => item.startsWith('ADMIN_WEB_PORT="3o3o"')));
  });

  await test('takeSendAttempt membatasi percobaan per hari per jenis', () => {
    const waId = '6200000001@c.us';
    assert.strictEqual(takeSendAttempt(waId, 'fe_poll', '2026-09-26', 2), true);
    assert.strictEqual(takeSendAttempt(waId, 'fe_poll', '2026-09-26', 2), true);
    assert.strictEqual(takeSendAttempt(waId, 'fe_poll', '2026-09-26', 2), false);
    assert.strictEqual(takeSendAttempt(waId, 'delivery_week39_daily', '2026-09-26', 2), true);
    assert.strictEqual(takeSendAttempt(waId, 'fe_poll', '2026-09-27', 2), true);
    assert.strictEqual(takeSendAttempt('6200000002@c.us', 'fe_poll', '2026-09-26', 2), true);
  });

  await test('rate limit login memblokir setelah batas dan pulih setelah jendela', () => {
    const ip = '10.0.0.9';
    const t0 = 1_000_000;
    clearAdminLoginFailures(ip);
    for (let i = 0; i < 5; i += 1) {
      assert.strictEqual(checkAdminLoginAllowed(ip, t0 + i).allowed, true);
      registerAdminLoginFailure(ip, 'admin', t0 + i);
    }
    assert.strictEqual(checkAdminLoginAllowed(ip, t0 + 10).allowed, false);
    assert.strictEqual(checkAdminLoginAllowed(ip, t0 + 16 * 60 * 1000).allowed, true);
    clearAdminLoginFailures(ip);
    assert.strictEqual(checkAdminLoginAllowed(ip, t0 + 10).allowed, true);
  });

  await test('tabel settings bisa simpan dan baca nilai', async () => {
    const { dir, db } = tempDb();
    try {
      await ensureSettingsTable(db);
      assert.strictEqual(await getSetting(db, 'tidak_ada', 'fallback'), 'fallback');
      await setSetting(db, 'jam_kirim_awal', 6);
      assert.strictEqual(await getSetting(db, 'jam_kirim_awal'), '6');
      await setSetting(db, 'jam_kirim_awal', 7);
      assert.strictEqual(await getSetting(db, 'jam_kirim_awal'), '7');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('checkDbIntegrity melaporkan ok pada database sehat', async () => {
    const { dir, db } = tempDb();
    try {
      const result = await checkDbIntegrity(db);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.result, 'ok');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('pemuat .env mengurai komentar, kutip, dan tidak menimpa env yang ada', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-env-'));
    const file = path.join(dir, '.env');
    fs.writeFileSync(
      file,
      ['# komentar', 'SEND_MIN_GAP_MS=4200', 'ADMIN_WEB_USER="bunda"', 'KOSONG=', 'BUKAN_ENV'].join('\n'),
    );
    try {
      const parsed = parseEnvContent(fs.readFileSync(file, 'utf8'));
      assert.strictEqual(parsed.SEND_MIN_GAP_MS, '4200');
      assert.strictEqual(parsed.ADMIN_WEB_USER, 'bunda');
      assert.strictEqual(parsed.KOSONG, '');
      assert.strictEqual(parsed.BUKAN_ENV, undefined);

      const target = { SEND_MIN_GAP_MS: '9999' };
      const result = loadEnvFile(file, target);
      assert.strictEqual(target.SEND_MIN_GAP_MS, '9999', 'env yang sudah ada tidak ditimpa');
      assert.strictEqual(target.ADMIN_WEB_USER, 'bunda');
      assert.strictEqual(result.found, true);
      assert.ok(result.loaded >= 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('pemuat .env aman kalau file tidak ada', () => {
    const result = loadEnvFile('/tmp/tidak-ada-file-env-ini');
    assert.strictEqual(result.found, false);
    assert.strictEqual(result.loaded, 0);
  });

  await test('guard mencatat error permanen per penerima', async () => {
    const logger = { warn() {}, error() {}, log() {} };
    const guard = createSendGuard({
      env: {
        SEND_MIN_GAP_MS: '1',
        SEND_JITTER_MS: '1',
        SEND_MAX_QUEUE_WAIT_MS: '0',
        SEND_WARMUP_ENABLED: '0',
        SEND_MAX_PER_MINUTE: '100',
        SEND_MAX_PER_HOUR: '100',
        SEND_MAX_PER_DAY: '100',
      },
      logger,
      random: () => 0,
      localNow: () => ({ hour: 10, minute: 0 }),
    });
    guard.setReady(true);
    assert.strictEqual(guard.lastErrorFor('628123@c.us'), null);
    await guard.send(async () => {
      throw new Error('Number not registered on WhatsApp');
    }, { label: '628123@c.us' });
    const info = guard.lastErrorFor('628123@c.us');
    assert.ok(info);
    assert.strictEqual(info.permanent, true);

    await guard.send(async () => {
      throw new Error('Evaluation failed: timeout');
    }, { label: '628999@c.us' });
    assert.strictEqual(guard.lastErrorFor('628999@c.us').permanent, false);
  });

  console.log('\nsemua tes P1 lulus');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});