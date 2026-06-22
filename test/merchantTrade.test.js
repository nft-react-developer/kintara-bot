const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MERCHANT_APPROACH,
  spawnToMerchantPresenceState,
  returnMerchantToMainland,
  navigateToMerchant,
  tradeMaximumGold,
} = require('../lib/merchantTrade');

test('merchant worker maps persisted realms to headless Presence state', () => {
  assert.deepEqual(spawnToMerchantPresenceState({ realm: 'world', col: 21, row: 11 }), {
    region: 'world', x: -9.5, y: 0.25, z: -19.5, ry: 0,
  });
  assert.equal(spawnToMerchantPresenceState({ realm: 'pond', col: 2, row: 20 }).region, 'pond');
  assert.equal(spawnToMerchantPresenceState({ realm: 'wild', col: 25, row: 47 }).region, 'wild');
  assert.equal(spawnToMerchantPresenceState({ realm: 'alchemistShop', col: 4, row: 4 }).region, 'alchemist_shop');
});

test('merchant navigation returns from pond and walks to the mainland approach tile', async () => {
  const calls = [];
  const presence = {
    region: 'pond',
    pos: { x: 0, y: 0.25, z: 0 },
    waitForRegionConfirmation: async () => 'world',
    setRegion(region, x, z) { this.region = region; this.pos.x = x; this.pos.z = z; calls.push(['region', region, x, z]); },
    async walkTo(x, z) { this.pos.x = x; this.pos.z = z; calls.push(['walk', x, z]); return 'arrived'; },
  };
  await navigateToMerchant(presence);
  assert.equal(presence.region, 'world');
  assert.deepEqual(calls.at(-1), ['walk', MERCHANT_APPROACH.x, MERCHANT_APPROACH.z]);
});

test('merchant return rejects unsupported automated regions', async () => {
  await assert.rejects(() => returnMerchantToMainland({ region: 'casino', pos: {} }), /unsupported merchant return region/);
});

test('merchant trade loops until the complete bundles are exhausted', async () => {
  let backpack = { wood: 5000, stone: 3000, coal: 1400, cooked_fish_meat: 60, gold: 4 };
  let stock = 3;
  const client = {
    merchantCampaign: async () => ({ mode: 'gold_trade', goldTradeEnabled: true, goldStock: stock }),
    me: async () => ({ backpack }),
    merchantTradeForGold: async () => {
      backpack = {
        ...backpack,
        wood: backpack.wood - 2500,
        stone: backpack.stone - 1500,
        coal: backpack.coal - 700,
        cooked_fish_meat: backpack.cooked_fish_meat - 30,
        gold: backpack.gold + 1,
      };
      stock--;
      return { ok: true, backpack, campaign: { mode: 'gold_trade', goldTradeEnabled: true, goldStock: stock } };
    },
  };
  const result = await tradeMaximumGold(client, { delayMs: 0 });
  assert.equal(result.traded, 2);
  assert.equal(result.goldAfter, 6);
  assert.equal(result.reason, 'no_complete_bundle_or_stock');
});

test('merchant trade preserves daily-cap reset metadata', async () => {
  const resetAtMs = Date.now() + 60000;
  const error = new Error('merchant_daily_cap');
  error.body = { error: 'merchant_daily_cap', resetAtMs };
  const client = {
    merchantCampaign: async () => ({ mode: 'gold_trade', goldStock: 10 }),
    me: async () => ({ backpack: { wood: 2500, stone: 1500, coal: 700, cooked_fish_meat: 30, gold: 1 } }),
    merchantTradeForGold: async () => { throw error; },
  };
  const result = await tradeMaximumGold(client, { delayMs: 0 });
  assert.equal(result.traded, 0);
  assert.equal(result.reason, 'merchant_daily_cap');
  assert.equal(result.resetAtMs, resetAtMs);
});
