const test = require('node:test');
const assert = require('node:assert/strict');
const { KintaraClient } = require('../lib/kintaraClient');

test('merchant campaign falls back to the authoritative API when fanout is unavailable', async () => {
  const client = new KintaraClient({ cookie: 'test=1' });
  const calls = [];
  client.fanoutGet = async (path) => {
    calls.push(['fanout', path]);
    throw new Error('maintenance');
  };
  client.get = async (path) => {
    calls.push(['authoritative', path]);
    return { ok: true, mode: 'resting' };
  };

  assert.deepEqual(await client.merchantCampaign(), { ok: true, mode: 'resting' });
  assert.deepEqual(calls, [
    ['fanout', '/api/world/merchant-campaign'],
    ['authoritative', '/api/world/merchant-campaign'],
  ]);
});

test('merchant campaign keeps the fanout response when it succeeds', async () => {
  const client = new KintaraClient({ cookie: 'test=1' });
  client.fanoutGet = async () => ({ ok: true, mode: 'gold_trade' });
  client.get = async () => { throw new Error('authoritative endpoint should not be called'); };
  assert.deepEqual(await client.merchantCampaign(), { ok: true, mode: 'gold_trade' });
});
