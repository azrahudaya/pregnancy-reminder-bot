'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const {
  coerceSetting,
  settingsSnapshot,
  saveRuntimeSettings,
  loadRuntimeSettings,
  getMaxSendAttempts,
  isAllowlistEnforced,
  applyAdminUserAction,
  ensureSettingsTable,
  getSetting,
} = require('../index');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-p2-'));
  const db = new sqlite3.Database(path.join(dir, 'test.db'));
  return { dir, db };
}

function makeGuard() {
  const logger = { warn() {}, error() {}, log() {} };
  const guard = createSendGuard({
    env: {
      SEND_MIN_GAP_MS: '20',
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
  return guard;
}

async function main() {
  await test('coerceSetting menolak nilai di luar rentang dan kunci tak dikenal', () => {
    assert.strictEqual(coerceSetting('send_min_gap_ms', 100).ok, false);
    assert.strictEqual(coerceSetting('send_min_gap_ms', 5000).value, 5000);
    assert.strictEqual(coerceSetting('tidak_ada', 1).ok, false);
    assert.strictEqual(coerceSetting('enforce_allowlist', 'ya').value, 1);
    assert.strictEqual(coerceSetting('enforce_allowlist', 'tidak').value, 0);
    assert.strictEqual(coerceSetting('reminder_skip_weekday', -1).value, -1);
    assert.strictEqual(coerceSetting('send_max_per_minute', 'abc').ok, false);
  });

  await test('guard menerapkan konfigurasi runtime dan mengabaikan nilai tak sah', () => {
    const guard = makeGuard();
    const applied = guard.setRuntimeConfig({
      minGapMs: 4200,
      maxPerMinute: 8,
      maxPerHour: 90,
      windowEndHour: 20,
      tidakDikenal: 99,
      jitterMs: -5,
    });
    assert.strictEqual(guard.config.minGapMs, 4200);
    assert.strictEqual(guard.config.maxPerMinute, 8);
    assert.strictEqual(guard.config.windowEndHour, 20);
    assert.strictEqual(applied.tidakDikenal, undefined);
    assert.strictEqual(guard.config.jitterMs, 1, 'nilai negatif diabaikan');
  });

  await test('mode simulasi mencatat dan tidak mengirim', async () => {
    const guard = makeGuard();
    let called = 0;
    guard.setDryRun(true);
    const result = await guard.send(async () => {
      called += 1;
      return { id: { _serialized: 'x' } };
    }, { label: '62811@c.us', preview: 'contoh pesan' });
    assert.strictEqual(result, null);
    assert.strictEqual(called, 0, 'fungsi kirim tidak boleh dipanggil');
    assert.strictEqual(guard.stats().simulated, 1);
    assert.strictEqual(guard.isDryRun(), true);

    guard.setDryRun(false);
    const after = await guard.send(async () => ({ id: { _serialized: 'y' } }));
    assert.ok(after);
    assert.strictEqual(guard.stats().sent, 1);
  });

  await test('simpan dan muat pengaturan lewat tabel settings', async () => {
    const { dir, db } = tempDb();
    try {
      await ensureSettingsTable(db);
      const saved = await saveRuntimeSettings(db, {
        send_max_per_minute: 7,
        reminder_skip_weekday: 7,
        max_send_attempts: 6,
        send_min_gap_ms: 50,
      });
      assert.strictEqual(saved.applied.send_max_per_minute, 7);
      assert.strictEqual(saved.rejected.length, 1, 'satu nilai ditolak karena di bawah batas');
      assert.strictEqual(await getSetting(db, 'send_max_per_minute'), '7');

      const snapshot = settingsSnapshot();
      assert.strictEqual(snapshot.send_max_per_minute, 7);
      assert.strictEqual(snapshot.max_send_attempts, 6);
      assert.strictEqual(getMaxSendAttempts(), 6);

      await saveRuntimeSettings(db, { enforce_allowlist: 0 });
      assert.strictEqual(isAllowlistEnforced(), false);
      await loadRuntimeSettings(db);
      assert.strictEqual(getMaxSendAttempts(), 6, 'nilai bertahan setelah muat ulang');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('aksi admin menolak masukan tidak sah', async () => {
    const { dir, db } = tempDb();
    try {
      const user = { wa_id: '628123@c.us' };
      const badTime = await applyAdminUserAction(db, user, 'set_reminder_time', '99:99');
      assert.strictEqual(badTime.ok, false);
      const badAction = await applyAdminUserAction(db, user, 'aksi_aneh', 'x');
      assert.strictEqual(badAction.ok, false);
      const deleteWithoutConfirm = await applyAdminUserAction(db, user, 'delete_data', 'hapus');
      assert.strictEqual(deleteWithoutConfirm.ok, false);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log('\nsemua tes P2 lulus');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});