'use strict';

const assert = require('assert');
const { DateTime } = require('luxon');
const {
  pickPollVariant,
  buildReminderQuestion,
  getProgramDay,
  noteScheduledSend,
  getScheduledSendCount,
  isOverDailyMessageQuota,
  sendAlert,
} = require('../index');

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`fail - ${name}`);
    throw err;
  }
}

const wib = (iso) => DateTime.fromISO(iso, { zone: 'Asia/Jakarta' });

async function main() {
  await test('varian poll deterministik per user dan tanggal', () => {
    const user = { wa_id: '628111@c.us' };
    const first = pickPollVariant(user, '2026-09-26');
    assert.strictEqual(first, pickPollVariant(user, '2026-09-26'));
    const variants = new Set(
      ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26'].map(
        (date) => pickPollVariant(user, date),
      ),
    );
    assert.ok(variants.size >= 3, `varian yang muncul hanya ${variants.size}`);
    assert.ok(typeof first === 'string' && first.length > 5);
  });

  await test('pertanyaan poll berbeda antar user pada hari yang sama', () => {
    const questions = new Set(
      ['628111@c.us', '628222@c.us', '628333@c.us', '628444@c.us'].map((waId) =>
        buildReminderQuestion({ wa_id: waId }, wib('2026-09-26T19:30:00')),
      ),
    );
    assert.ok(questions.size >= 2, 'semua user mendapat pertanyaan yang sama');
  });

  await test('buildReminderQuestion tetap bekerja tanpa argumen', () => {
    const question = buildReminderQuestion();
    assert.ok(typeof question === 'string' && question.length > 5);
  });

  await test('getProgramDay menghitung hari sejak user dibuat', () => {
    const user = { created_at: '2026-09-16T08:00:00+07:00' };
    assert.strictEqual(getProgramDay(user, wib('2026-09-26T09:00:00')), 11);
    assert.strictEqual(getProgramDay({}, wib('2026-09-26T09:00:00')), null);
    assert.strictEqual(getProgramDay({ created_at: 'bukan tanggal' }, wib('2026-09-26T09:00:00')), null);
  });

  await test('kuota pesan per user per hari dihitung per hari', () => {
    const waId = '628777@c.us';
    const user = { wa_id: waId };
    assert.strictEqual(getScheduledSendCount(waId, '2026-09-26'), 0);
    assert.strictEqual(isOverDailyMessageQuota(user, '2026-09-26'), false);
    noteScheduledSend(waId, '2026-09-26');
    noteScheduledSend(waId, '2026-09-26');
    noteScheduledSend(waId, '2026-09-26');
    assert.strictEqual(getScheduledSendCount(waId, '2026-09-26'), 3);
    assert.strictEqual(isOverDailyMessageQuota(user, '2026-09-26'), true);
    assert.strictEqual(isOverDailyMessageQuota(user, '2026-09-27'), false, 'hari baru kuota baru');
  });

  await test('alarm menghormati masa tenang supaya tidak membanjiri log', () => {
    const first = sendAlert('uji-alarm', 'percobaan pertama');
    const second = sendAlert('uji-alarm', 'percobaan kedua');
    assert.strictEqual(first, true);
    assert.strictEqual(second, false);
    assert.strictEqual(sendAlert('uji-alarm-lain', 'jenis berbeda'), true);
  });

  console.log('\nsemua tes P4 lulus');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});