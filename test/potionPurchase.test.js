const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePotionQuantity, normalizePotionType } = require('../lib/potionCommand');
const {
  SHOP,
  navigateToShop,
  buyPotions,
  leaveShop,
  runPotionPurchase,
  spawnToPresenceState,
  presencePositionToSpawn,
} = require('../lib/potionPurchase');

class FakePresence {
  constructor(region, x, z) {
    this.region = region;
    this.pos = { x, y: region === 'alchemist_shop' ? 0.41 : 0.25, z, ry: 0 };
    this.selfStateVersion = 1;
    this.moves = [];
    this.transitions = [];
  }

  async walkTo(x, z) {
    this.moves.push({ region: this.region, x, z });
    this.pos.x = x;
    this.pos.z = z;
    return 'arrived';
  }

  waitForRegionConfirmation(region) {
    return new Promise((resolve) => { this.confirmTransition = { region, resolve }; });
  }

  setRegion(region, x, z, y) {
    assert.equal(this.confirmTransition?.region, region);
    this.region = region;
    this.pos = { x, y, z, ry: 0 };
    this.selfStateVersion++;
    this.transitions.push({ region, x, z });
    this.confirmTransition.resolve(region);
    this.confirmTransition = null;
  }

  async waitForRegion(region) {
    assert.equal(this.region, region);
    return region;
  }

  async waitForSelfState({ region = null, afterVersion = 0 }) {
    if (region) assert.equal(this.region, region);
    assert.ok(this.selfStateVersion > afterVersion);
    return { region: this.region, ...this.pos, version: this.selfStateVersion };
  }
}

test('potion command accepts supported types and quantities only', () => {
  assert.equal(normalizePotionType('health'), 'potion_health');
  assert.equal(normalizePotionType('potion_poison'), 'potion_poison');
  assert.equal(normalizePotionType('mana'), null);
  assert.equal(parsePotionQuantity('999'), 999);
  assert.equal(parsePotionQuantity('0'), null);
  assert.equal(parsePotionQuantity('1000'), null);
  assert.equal(parsePotionQuantity('1.5'), null);
});

test('persisted player spawn converts to Presence coordinates', () => {
  assert.deepEqual(spawnToPresenceState({ realm: 'world', col: 12, row: 3 }), {
    region: 'world', x: -18.5, y: 0.25, z: -27.5, ry: 0,
  });
  assert.deepEqual(spawnToPresenceState({ realm: 'alchemistShop', col: 5, row: 2 }), {
    region: 'alchemist_shop', x: 1, y: 0.41, z: -2, ry: 0,
  });
  assert.deepEqual(presencePositionToSpawn('alchemist_shop', { x: 0, z: 3 }), {
    realm: 'alchemistShop', col: 4, row: 7,
  });
  assert.throws(() => spawnToPresenceState({ realm: 'pond', col: 1, row: 1 }), /unsupported starting region/);
});

test('navigation starts from the actual position when already inside the shop', async () => {
  const presence = new FakePresence('alchemist_shop', -4.25, 2.75);
  await navigateToShop(presence);
  assert.deepEqual(presence.moves, [{ region: 'alchemist_shop', x: 1, z: -2 }]);
});

test('navigation enters from world and exits through the confirmed coordinates', async () => {
  const presence = new FakePresence('world', 12, 8);
  await navigateToShop(presence);
  await leaveShop(presence);
  assert.deepEqual(presence.moves, [
    { region: 'world', x: -18.5, z: -27.5 },
    { region: 'alchemist_shop', x: 1, z: -2 },
    { region: 'alchemist_shop', x: 0, z: 4 },
  ]);
  assert.deepEqual(presence.transitions, [
    { region: 'alchemist_shop', x: 0, z: 3 },
    { region: 'world', x: -18.5, z: -27.5 },
  ]);
  assert.equal(presence.region, 'world');
});

test('navigation rejects unsupported starting regions without moving', async () => {
  const presence = new FakePresence('pond', 0, 0);
  await assert.rejects(navigateToShop(presence), /unsupported starting region: pond/);
  assert.deepEqual(presence.moves, []);
});

test('purchase stops on rejection and reports the actual fulfilled quantity', async () => {
  let count = 15;
  let calls = 0;
  const client = {
    async alchemistPotionBuy(type, qty) {
      assert.equal(type, 'potion_health');
      assert.equal(qty, 1);
      calls++;
      if (calls === 3) throw new Error('not_enough_resources');
      count++;
      return { ok: true, backpack: { potion_health: count } };
    },
  };

  const result = await buyPotions(client, 'health', 5, {
    initialBackpack: { potion_health: 15 },
    delayMs: 0,
  });
  assert.equal(result.requested, 5);
  assert.equal(result.purchased, 2);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'not_enough_resources');
});

test('complete purchase flow enters, buys, and returns to world', async () => {
  const presence = new FakePresence('world', 8, 9);
  let count = 3;
  const client = {
    async me() { return { backpack: { potion_shield: count } }; },
    async saveSpawn() {},
    async alchemistPotionBuy() {
      count++;
      return { ok: true, backpack: { potion_shield: count } };
    },
  };
  const result = await runPotionPurchase({
    presence,
    client,
    potionType: 'shield',
    quantity: 2,
  });
  assert.equal(result.complete, true);
  assert.equal(result.purchased, 2);
  assert.equal(presence.region, 'world');
});
