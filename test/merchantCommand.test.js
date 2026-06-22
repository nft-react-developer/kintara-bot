const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MERCHANT_TRADE_COST,
  merchantResourceSnapshot,
  parseMerchantTradeCostSource,
  maxMerchantTrades,
  merchantWatcherButtons,
  formatMerchantStatus,
} = require('../lib/merchantCommand');
const { runMerchantWatcherTick } = require('../lib/merchantRuntime');
const {
  readMerchantWatcherState,
  writeMerchantWatcherState,
  createMerchantLogger,
  applyMerchantWatcherAction,
  createNonOverlappingPoller,
} = require('../lib/merchantRuntime');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('merchant cost parser reads every material from the live client block', () => {
  const cost = parseMerchantTradeCostSource(`
const MERCHANT_TRADE_COST = [
  { type: 'wood', amount: 2500 },
  { type: 'stone', amount: 1500 },
  { type: 'coal', amount: 700 },
  { type: 'cooked_fish_meat', amount: 30 },
];
  `);
  assert.deepEqual(cost, MERCHANT_TRADE_COST);
});

test('maximum merchant trades is limited by the scarcest material and gold stock', () => {
  const resources = merchantResourceSnapshot({ wood: 10000, stone: 7000, coal: 2800, cooked_fish_meat: 500 });
  assert.equal(maxMerchantTrades(resources, { mode: 'gold_trade', goldStock: 3 }), 3);
  assert.equal(maxMerchantTrades(resources, { mode: 'resting', goldStock: 3000 }), 0);
});

test('merchant status exposes dynamic watcher buttons and current materials', () => {
  assert.equal(merchantWatcherButtons({ enabled: true })[0][0].data, 'mr:pause');
  assert.equal(merchantWatcherButtons({ enabled: false })[0][0].data, 'mr:activate');
  const text = formatMerchantStatus({
    state: { enabled: true },
    campaign: { mode: 'gold_trade', goldStock: 3, goldStockFull: 3000 },
    resources: { wood: 5000, stone: 3000, coal: 1400, cooked_fish_meat: 60 },
    maxTrades: 2,
  });
  for (const expected of ['Watcher: <b>Active', 'gold_trade', 'Gold stock: <b>3 / 3,000', 'Wood', 'Stone', 'Coal', 'Cooked fish', 'Maximum trades now: <b>2']) {
    assert.match(text, new RegExp(expected));
  }
});

test('watcher tick starts once only when a complete trade is possible', async () => {
  let starts = 0;
  const deps = {
    state: { enabled: true },
    fetchSnapshot: async () => ({ campaign: { mode: 'gold_trade', goldStock: 2 }, maxTrades: 2 }),
    startJob: async () => { starts++; },
  };
  const result = await runMerchantWatcherTick(deps);
  assert.equal(result.started, true);
  assert.equal(starts, 1);
  const skipped = await runMerchantWatcherTick({ ...deps, jobActive: true });
  assert.equal(skipped.skipped, 'job_active');
  assert.equal(starts, 1);
});

test('merchant watcher is enabled by default and persists manual pause', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merchant-state-'));
  const file = path.join(dir, 'control', 'merchant-watcher.json');
  assert.equal(readMerchantWatcherState(file).enabled, true);
  writeMerchantWatcherState(file, { enabled: false, pausePending: false });
  assert.equal(readMerchantWatcherState(file).enabled, false);
});

test('merchant watcher button actions pause immediately or after the active job', () => {
  assert.deepEqual(
    applyMerchantWatcherAction({ enabled: true }, 'pause', { jobActive: false }).enabled,
    false
  );
  const pending = applyMerchantWatcherAction({ enabled: true }, 'pause', { jobActive: true });
  assert.equal(pending.enabled, true);
  assert.equal(pending.pausePending, true);
  assert.equal(applyMerchantWatcherAction(pending, 'activate').pausePending, false);
});

test('merchant logger records actions without creating poll noise by itself', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merchant-log-'));
  const file = path.join(dir, 'merchant.log');
  const log = createMerchantLogger(file, { now: () => new Date('2026-06-22T12:00:00.000Z') });
  log('trade_attempt', { number: 1 });
  assert.equal(fs.readFileSync(file, 'utf8'), '[2026-06-22T12:00:00.000Z] trade_attempt {"number":1}\n');
});

test('merchant poller never overlaps an active request', async () => {
  let release;
  let calls = 0;
  const poll = createNonOverlappingPoller(async () => {
    calls++;
    await new Promise((resolve) => { release = resolve; });
    return 'complete';
  });
  const first = poll();
  assert.deepEqual(await poll(), { skipped: 'in_flight' });
  assert.equal(calls, 1);
  release();
  assert.equal(await first, 'complete');
});
