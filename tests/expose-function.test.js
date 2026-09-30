'use strict';

const assert = require('assert');
const { exposeFunctionIfAbsent } = require('whatsapp-web.js/src/util/Puppeteer');

async function run() {
  const page = {
    async evaluate() {
      return false;
    },
    async exposeFunction(name) {
      if (name === 'onQRChangedEvent') {
        throw new Error(`Failed to add page binding with name ${name}: window['${name}'] already exists!`);
      }
    },
  };

  await assert.doesNotReject(() => exposeFunctionIfAbsent(page, 'onQRChangedEvent', () => {}));
  console.log('ok - duplicate exposed binding during navigation is tolerated');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
