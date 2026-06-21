const test = require('node:test');
const assert = require('node:assert/strict');
const { Presence } = require('../lib/presenceWs');

test('authoritative mode starts without a fabricated world position', () => {
  const presence = new Presence('s4', { synchronizeSelf: true });
  assert.equal(presence.region, null);
  assert.equal(presence.pos.x, null);
  assert.equal(presence.pos.z, null);
  assert.equal(presence.selfState, null);
});

test('waitForSelfState resolves from the matching player snapshot', async () => {
  const presence = new Presence('s4', { synchronizeSelf: true });
  presence.myId = 42;
  const waiting = presence.waitForSelfState({ timeoutMs: 100 });

  presence._onSnap({
    t: 'snap',
    region: 'alchemist_shop',
    players: [{ id: 7, x: 99, z: 99 }, { id: 42, x: -2.5, y: 0.41, z: 1.25, ry: 2 }],
  });

  const state = await waiting;
  assert.deepEqual(state, {
    region: 'alchemist_shop', x: -2.5, y: 0.41, z: 1.25, ry: 2, version: 1,
  });
  assert.equal(presence.region, 'alchemist_shop');
  assert.equal(presence.pos.x, -2.5);
  assert.equal(presence.pos.z, 1.25);
});

test('self snapshot prefers the per-player pr region used by the public client', async () => {
  const presence = new Presence('s4', { synchronizeSelf: true });
  presence.myId = 42;
  presence._onSnap({
    region: 'world',
    players: [{ id: 42, pr: 'alchemist_shop', x: 1, y: 0.41, z: -2 }],
  });
  assert.equal(presence.region, 'alchemist_shop');
});

test('waitForSelfState rejects when no authoritative position arrives', async () => {
  const presence = new Presence('s4', { synchronizeSelf: true });
  await assert.rejects(
    presence.waitForSelfState({ timeoutMs: 10 }),
    /self state synchronization timeout/,
  );
});

test('walkTo refuses to move before synchronization', async () => {
  const presence = new Presence('s4', { synchronizeSelf: true });
  await assert.rejects(presence.walkTo(1, 2), /before self position is synchronized/);
});

test('same-region snapshots do not rewind an active walk but transitions still synchronize', () => {
  const presence = new Presence('s4', { synchronizeSelf: true });
  presence.myId = 42;
  presence.region = 'world';
  presence.pos = { x: 5, y: 0.25, z: 6, ry: 0 };
  presence._walking = true;

  presence._onSnap({ region: 'world', players: [{ id: 42, x: 1, z: 2 }] });
  assert.equal(presence.pos.x, 5);
  assert.equal(presence.pos.z, 6);

  presence._onSnap({ region: 'alchemist_shop', players: [{ id: 42, x: 0, y: 0.41, z: 3 }] });
  assert.equal(presence.region, 'alchemist_shop');
  assert.equal(presence.pos.x, 0);
  assert.equal(presence.pos.z, 3);
});
