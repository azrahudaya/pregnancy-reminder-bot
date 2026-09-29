'use strict';

const assert = require('assert');
const { pairingOptions } = require('../index');

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`fail - ${name}`);
    throw err;
  }
}

(async () => {
  await test('nomor kosong berarti jalur QR tetap dipakai', () => {
    assert.deepStrictEqual(pairingOptions(''), {});
    assert.deepStrictEqual(pairingOptions(undefined), {});
    assert.deepStrictEqual(pairingOptions('+ - ( )'), {});
  });

  await test('nomor dinormalkan jadi digit saja', () => {
    const opts = pairingOptions('+62 812-3456-7890');
    assert.strictEqual(opts.pairWithPhoneNumber.phoneNumber, '6281234567890');
  });

  await test('notifikasi sistem dimatikan dan interval default 3 menit', () => {
    const opts = pairingOptions('6281234567890');
    assert.strictEqual(opts.pairWithPhoneNumber.showNotification, false);
    assert.strictEqual(opts.pairWithPhoneNumber.intervalMs, 180000);
  });

  console.log('\nsemua tes pairing lulus');
})();
