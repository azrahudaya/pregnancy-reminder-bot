'use strict';

const assert = require('assert');
const {
  parseDeliveryValidationAnswer,
  isReminderControlCommand,
  parsePostpartumCorrection,
  resolveVisitCode,
} = require('../index');

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`fail - ${name}`);
    throw err;
  }
}

test('validasi persalinan menerima jawaban panjang', () => {
  assert.strictEqual(parseDeliveryValidationAnswer('sudah melahirkan'), 'Sudah');
  assert.strictEqual(parseDeliveryValidationAnswer('udah melahir tadi pagi'), 'Sudah');
  assert.strictEqual(parseDeliveryValidationAnswer('belum melahirkan'), 'Belum');
});

test('validasi persalinan menerima jawaban pendek', () => {
  assert.strictEqual(parseDeliveryValidationAnswer('Sudah'), 'Sudah');
  assert.strictEqual(parseDeliveryValidationAnswer('ya'), 'Sudah');
  assert.strictEqual(parseDeliveryValidationAnswer('Belum'), 'Belum');
  assert.strictEqual(parseDeliveryValidationAnswer('tidak'), 'Belum');
  assert.strictEqual(parseDeliveryValidationAnswer('nggak'), 'Belum');
});

test('validasi persalinan tetap menolak jawaban tak jelas', () => {
  assert.strictEqual(parseDeliveryValidationAnswer('besok'), null);
  assert.strictEqual(parseDeliveryValidationAnswer(''), null);
  assert.strictEqual(parseDeliveryValidationAnswer('mungkin'), null);
});

test('perintah kendali dikenali walau sedang onboarding', () => {
  ['start', 'mulai', 'stop', 'berhenti', 'ubah jam 19:30', 'jam 7', 'set jam 17.00'].forEach(
    (text) => assert.strictEqual(isReminderControlCommand(text), true, text),
  );
  ['Bunda Sari', 'jakarta', '19:30', 'sudah'].forEach((text) =>
    assert.strictEqual(isReminderControlCommand(text), false, text),
  );
});

test('koreksi kunjungan nifas mengurai kode dan jawaban', () => {
  assert.deepStrictEqual(parsePostpartumCorrection('koreksi kfkn2 sudah'), {
    rawCode: 'KFKN2',
    response: 'Sudah',
  });
  assert.deepStrictEqual(parsePostpartumCorrection('Koreksi kunjungan KF 3 belum'), {
    rawCode: 'KF3',
    response: 'Belum',
  });
  assert.strictEqual(parsePostpartumCorrection('koreksi kf9 sudah'), null);
  assert.strictEqual(parsePostpartumCorrection('koreksi apa saja'), null);
});

test('kode kunjungan lama dipetakan ke kode sekarang', () => {
  assert.strictEqual(resolveVisitCode('KFKN1'), 'KFKN1');
  assert.strictEqual(resolveVisitCode('KF2'), 'KFKN2');
  assert.strictEqual(resolveVisitCode('KN3'), 'KFKN3');
  assert.strictEqual(resolveVisitCode('KF9'), null);
});

console.log('\nsemua tes P3 lulus');