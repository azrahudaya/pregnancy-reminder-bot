'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createSendGuard } = require('../lib/send-guard');

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`))
    .catch((err) => {
      console.error(`fail - ${name}`);
      throw err;
    });
}

const baseEnv = {
  SEND_MIN_GAP_MS: '20',
  SEND_JITTER_MS: '5',
  REPLY_MIN_GAP_MS: '5',
  REPLY_JITTER_MS: '1',
  SEND_MAX_PER_MINUTE: '100',
  SEND_MAX_PER_HOUR: '100',
  SEND_MAX_PER_DAY: '100',
  SEND_MAX_QUEUE_WAIT_MS: '0',
  SEND_WARMUP_ENABLED: '0',
};

const silentLogger = { warn() {}, error() {}, log() {} };

function makeGuard(env = {}, options = {}) {
  const guard = createSendGuard({
    env: { ...baseEnv, ...env },
    logger: silentLogger,
    random: () => 0,
    localNow: () => ({ hour: 10, minute: 0 }),
    ...options,
  });
  guard.setReady(true);
  return guard;
}

async function main() {
  await test('menahan semua kirim saat client belum siap', async () => {
    const guard = makeGuard();
    guard.setReady(false);
    let called = 0;
    const result = await guard.send(async () => {
      called += 1;
      return { id: { _serialized: 'x' } };
    });
    assert.strictEqual(result, null);
    assert.strictEqual(called, 0);
    assert.strictEqual(guard.stats().skippedNotReady, 1);
  });

  await test('serial (tidak ada kirim paralel) dan ada jeda antar pesan', async () => {
    const guard = makeGuard();
    let inFlight = 0;
    let maxInFlight = 0;
    const stamps = [];
    const jobs = [];
    for (let i = 0; i < 5; i += 1) {
      jobs.push(
        guard.send(async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          stamps.push(Date.now());
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
          return { id: { _serialized: `m${i}` } };
        }),
      );
    }
    const results = await Promise.all(jobs);
    assert.strictEqual(maxInFlight, 1, 'harus satu pengiriman pada satu waktu');
    assert.strictEqual(results.filter(Boolean).length, 5);
    const gaps = stamps.slice(1).map((ts, i) => ts - stamps[i]);
    assert.ok(
      gaps.every((gap) => gap >= 15),
      `setiap jeda harus >= 15ms, dapat ${gaps.join(',')}`,
    );
    assert.strictEqual(guard.stats().sent, 5);
  });

  await test('kuota per menit menolak kiriman berlebih tanpa menyentuh client', async () => {
    const guard = makeGuard({ SEND_MAX_PER_MINUTE: '3' });
    let called = 0;
    const send = () =>
      guard.send(async () => {
        called += 1;
        return { id: { _serialized: 'a' } };
      });
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(await send());
    }
    assert.strictEqual(results.filter(Boolean).length, 3);
    assert.strictEqual(called, 3);
    assert.strictEqual(guard.stats().skippedQuota, 2);
    assert.strictEqual(guard.stats().lastReason, 'quota_menit');
  });

  await test('jendela jam kirim: broadcast ditolak di luar jam, balasan tetap boleh', async () => {
    const guard = makeGuard({}, { localNow: () => ({ hour: 3, minute: 0 }) });
    let called = 0;
    const fn = async () => {
      called += 1;
      return { id: { _serialized: 'b' } };
    };
    const broadcast = await guard.send(fn);
    assert.strictEqual(broadcast, null);
    assert.strictEqual(called, 0);
    assert.strictEqual(guard.stats().skippedWindow, 1);

    const reply = await guard.send(fn, { kind: 'reply' });
    assert.ok(reply);
    assert.strictEqual(called, 1);
  });

  await test('circuit breaker menjeda kirim setelah kegagalan permanen beruntun', async () => {
    const guard = makeGuard({ SEND_FAIL_BREAKER: '3', SEND_PAUSE_MS: '60000' });
    const failing = async () => {
      throw new Error('Number not registered on WhatsApp');
    };
    await guard.send(failing, { label: '1' });
    await guard.send(failing, { label: '2' });
    assert.strictEqual(guard.isPaused(), false);
    await guard.send(failing, { label: '3' });
    assert.strictEqual(guard.isPaused(), true);
    assert.strictEqual(guard.stats().breakerTrips, 1);

    let called = 0;
    const result = await guard.send(async () => {
      called += 1;
      return { id: { _serialized: 'c' } };
    });
    assert.strictEqual(result, null);
    assert.strictEqual(called, 0);
    assert.strictEqual(guard.stats().skippedPaused, 1);

    guard.resume();
    assert.strictEqual(guard.isPaused(), false);
    const afterResume = await guard.send(async () => ({ id: { _serialized: 'd' } }));
    assert.ok(afterResume);
  });

  await test('kegagalan sementara tidak menaikkan penghitung breaker', async () => {
    const guard = makeGuard({ SEND_FAIL_BREAKER: '2', SEND_PAUSE_MS: '60000' });
    const failing = async () => {
      throw new Error('Evaluation failed: timeout');
    };
    await guard.send(failing, { label: 't1' });
    await guard.send(failing, { label: 't2' });
    assert.strictEqual(guard.isPaused(), false);
    assert.strictEqual(guard.stats().permanentFailures, 0);
    assert.strictEqual(guard.stats().failures, 2);
  });

  await test('kirim sukses mereset penghitung kegagalan beruntun', async () => {
    const guard = makeGuard({ SEND_FAIL_BREAKER: '3', SEND_PAUSE_MS: '60000' });
    await guard.send(async () => {
      throw new Error('Number not registered on WhatsApp');
    });
    await guard.send(async () => {
      throw new Error('Number not registered on WhatsApp');
    });
    await guard.send(async () => ({ id: { _serialized: 'e' } }));
    await guard.send(async () => {
      throw new Error('Number not registered on WhatsApp');
    });
    assert.strictEqual(guard.isPaused(), false, 'reset setelah sukses');
  });

  await test('kuota harian mengikuti kurva warm-up sesi baru', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-guard-'));
    try {
      const guard = makeGuard(
        {
          SEND_WARMUP_ENABLED: '1',
          SEND_WARMUP_DAY1_MAX: '2',
          SEND_MAX_PER_DAY: '100',
        },
        { dataDir: tmp },
      );
      const send = () =>
        guard.send(async () => ({ id: { _serialized: 'w' } }));
      assert.ok(await send());
      assert.ok(await send());
      assert.strictEqual(await send(), null);
      assert.strictEqual(guard.stats().lastReason, 'kuota_harian');
      assert.strictEqual(guard.stats().dailyCap, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('hasil kirim kosong dihitung sebagai kegagalan', async () => {
    const guard = makeGuard();
    const result = await guard.send(async () => null);
    assert.strictEqual(result, null);
    assert.strictEqual(guard.stats().failures, 1);
  });

  console.log('\nsemua tes send-guard lulus');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});