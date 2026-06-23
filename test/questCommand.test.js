const test = require('node:test');
const assert = require('node:assert/strict');
const {
  claimReadyDailyQuests,
  formatQuestStatus,
  buildQuestCommandMessage,
  isQuestClaimable,
} = require('../lib/questCommand');

function snapshot({ prog = {}, claimed = {}, quests = [] } = {}) {
  return {
    dailyQuest: { day: '2026-06-23', prog, claimed },
    dailyQuestConfig: { quests },
  };
}

const QUESTS = [
  { id: 'q-wood', kind: 'wood', label: 'Chop wood', target: 10, rewardXpSpreadTotal: 100 },
  { id: 'q-fish', kind: 'fish', label: 'Catch fish', target: 5, rewardXpSpreadTotal: 50 },
];

test('daily quest status marks pending, ready, and claimed quests', () => {
  const text = formatQuestStatus(snapshot({
    prog: { 'q-wood': 10, 'q-fish': 2 },
    claimed: { 'q-wood': false },
    quests: QUESTS,
  }));
  assert.match(text, /📋 <b>Daily Quest<\/b> \(2026-06-23\)/);
  assert.match(text, /🎁 Chop wood — 10\/10 \(100XP\)/);
  assert.match(text, /▫️ Catch fish — 2\/5 \(50XP\)/);
});

test('claim readiness requires target progress and unclaimed state', () => {
  const state = { prog: { q: 3 }, claimed: {} };
  assert.equal(isQuestClaimable(state, { id: 'q', target: 3 }), true);
  assert.equal(isQuestClaimable({ ...state, claimed: { q: true } }, { id: 'q', target: 3 }), false);
  assert.equal(isQuestClaimable({ prog: { q: 2 }, claimed: {} }, { id: 'q', target: 3 }), false);
});

test('quest command claims ready quests before rendering refreshed active quests', async () => {
  const calls = [];
  const before = snapshot({
    prog: { 'q-wood': 10, 'q-fish': 2 },
    claimed: {},
    quests: QUESTS,
  });
  const after = snapshot({
    prog: { 'q-wood': 10, 'q-fish': 2 },
    claimed: { 'q-wood': true },
    quests: QUESTS,
  });
  const client = {
    dailyQuestProgress: async () => {
      calls.push('progress');
      return calls.filter((x) => x === 'progress').length === 1 ? before : after;
    },
    dailyQuestClaim: async (questId) => {
      calls.push(`claim:${questId}`);
      return { ok: true };
    },
  };

  const text = await buildQuestCommandMessage(client);

  assert.deepEqual(calls, ['progress', 'claim:q-wood', 'progress']);
  assert.match(text, /🎁 Auto-claimed: Chop wood/);
  assert.match(text, /✅ Chop wood — 10\/10 \(100XP\)/);
  assert.match(text, /▫️ Catch fish — 2\/5 \(50XP\)/);
});

test('claim helper reports failed claims without hiding current quests', async () => {
  const result = await claimReadyDailyQuests({
    dailyQuestClaim: async () => { throw new Error('claim failed'); },
  }, snapshot({ prog: { 'q-wood': 10 }, quests: [QUESTS[0]] }));

  assert.deepEqual(result.claimed, []);
  assert.deepEqual(result.failed, ['Chop wood']);
  assert.match(formatQuestStatus(result.snapshot, result), /⚠️ Claim failed: Chop wood/);
});
