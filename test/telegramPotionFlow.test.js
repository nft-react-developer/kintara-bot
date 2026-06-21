const test = require('node:test');
const assert = require('node:assert/strict');
const { potionSelectionButtons } = require('../tools/telegram-bot');

test('potion keyboard exposes every selection and confirmation callback', () => {
  const callbacks = potionSelectionButtons().flat().map((button) => button.data);
  for (const expected of [
    'pt:type:health', 'pt:type:shield', 'pt:type:strength', 'pt:type:poison',
    'pt:qty:10', 'pt:qty:25', 'pt:qty:50', 'pt:qty:100',
    'pt:custom', 'pt:confirm', 'pt:cancel',
  ]) {
    assert.ok(callbacks.includes(expected), `missing ${expected}`);
  }
  assert.ok(callbacks.every((value) => Buffer.byteLength(value) <= 64));
});
