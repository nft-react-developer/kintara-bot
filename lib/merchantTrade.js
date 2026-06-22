const {
  MERCHANT_TRADE_COST,
  merchantResourceSnapshot,
  merchantTradeEnabled,
  maxMerchantTrades,
} = require('./merchantCommand');

const MAINLAND_OFFSET = -30.5;
const POND_OFFSET = -19.5;
const WILD_OFFSET = -24.5;
const ALCHEMIST_OFFSET = -4;

const MERCHANT_APPROACH = Object.freeze({ x: MAINLAND_OFFSET + 18, z: MAINLAND_OFFSET + 11 });
const MAINLAND_RETURNS = Object.freeze({
  pond: Object.freeze({ x: MAINLAND_OFFSET + 60, z: MAINLAND_OFFSET + 31 }),
  wild: Object.freeze({ x: MAINLAND_OFFSET + 30, z: MAINLAND_OFFSET + 1 }),
  alchemist_shop: Object.freeze({ x: -18.5, z: -27.5 }),
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function failureReason(error) {
  const value = error?.body?.error || error?.body?.message || error?.message || error?.error || error;
  return String(value || 'rejected').slice(0, 180);
}

function spawnToMerchantPresenceState(spawn = {}) {
  const realm = String(spawn.realm || '');
  const col = Number(spawn.col);
  const row = Number(spawn.row);
  if (!Number.isFinite(col) || !Number.isFinite(row)) throw new Error('player spawn is missing valid coordinates');
  if (realm === 'world') return { region: 'world', x: MAINLAND_OFFSET + col, y: 0.25, z: MAINLAND_OFFSET + row, ry: 0 };
  if (realm === 'pond') return { region: 'pond', x: POND_OFFSET + col, y: 0.25, z: POND_OFFSET + row, ry: 0 };
  if (realm === 'alchemistShop' || realm === 'alchemist_shop') {
    return { region: 'alchemist_shop', x: ALCHEMIST_OFFSET + col, y: 0.41, z: ALCHEMIST_OFFSET + row, ry: 0 };
  }
  if (/^wild/.test(realm)) return { region: realm, x: WILD_OFFSET + col, y: 0.25, z: WILD_OFFSET + row, ry: 0 };
  throw new Error(`unsupported starting region: ${realm || 'unknown'}`);
}

async function synchronizeMerchantPosition(presence, log = () => {}) {
  log('position_sync_start');
  const state = await presence.waitForSelfState({ timeoutMs: 15000 });
  log('position_sync_complete', { region: state.region, x: state.x, z: state.z });
  return state;
}

async function returnMerchantToMainland(presence, log = () => {}) {
  const region = String(presence.region || '');
  if (region === 'world') return;
  const target = region === 'pond' ? MAINLAND_RETURNS.pond
    : /^wild/.test(region) ? MAINLAND_RETURNS.wild
      : region === 'alchemist_shop' ? MAINLAND_RETURNS.alchemist_shop
        : null;
  if (!target) throw new Error(`unsupported merchant return region: ${region || 'unknown'}`);
  log('region_return_attempt', { from: region, to: 'world', x: target.x, z: target.z });
  const confirmed = presence.waitForRegionConfirmation('world', 12000);
  presence.setRegion('world', target.x, target.z, 0.25);
  await confirmed;
  log('region_return_complete', { from: region, to: 'world', x: presence.pos.x, z: presence.pos.z });
}

async function navigateToMerchant(presence, log = () => {}) {
  await returnMerchantToMainland(presence, log);
  log('merchant_walk_start', MERCHANT_APPROACH);
  const result = await presence.walkTo(MERCHANT_APPROACH.x, MERCHANT_APPROACH.z, { maxSec: 45 });
  if (result !== 'arrived') throw new Error('timed out while walking to Traveling Merchant');
  log('merchant_walk_complete', { region: presence.region, x: presence.pos.x, z: presence.pos.z });
}

async function tradeMaximumGold(client, { cost = MERCHANT_TRADE_COST, initialCampaign = null, log = () => {}, delayMs = 150 } = {}) {
  let campaign = initialCampaign || await client.merchantCampaign();
  let backpack = (await client.me())?.backpack || {};
  const beforeGold = Number(backpack.gold) || 0;
  let traded = 0;
  let reason = null;
  let resetAtMs = 0;

  for (;;) {
    const resources = merchantResourceSnapshot(backpack);
    const possible = maxMerchantTrades(resources, campaign, cost);
    if (possible <= 0) {
      reason = merchantTradeEnabled(campaign) ? 'no_complete_bundle_or_stock' : 'merchant_not_trading';
      break;
    }
    log('trade_attempt', { number: traded + 1, resources, goldStock: Number(campaign.goldStock) || 0 });
    let response;
    try {
      response = await client.merchantTradeForGold({});
    } catch (error) {
      reason = failureReason(error);
      resetAtMs = Math.max(0, Number(error?.body?.resetAtMs) || 0);
      log('trade_rejected', { number: traded + 1, reason, resetAtMs });
      break;
    }
    if (!response || response.ok === false || response.error) {
      reason = failureReason(response || 'rejected');
      resetAtMs = Math.max(0, Number(response?.resetAtMs) || 0);
      log('trade_rejected', { number: traded + 1, reason, resetAtMs });
      break;
    }
    const nextBackpack = response.backpack || backpack;
    const previousGold = Number(backpack.gold) || 0;
    const nextGold = Number(nextBackpack.gold) || 0;
    if (nextGold <= previousGold) {
      reason = 'gold_did_not_increase';
      log('trade_rejected', { number: traded + 1, reason });
      break;
    }
    traded += Math.max(1, nextGold - previousGold);
    backpack = nextBackpack;
    campaign = response.campaign || campaign;
    log('trade_accepted', {
      traded,
      gold: nextGold,
      goldStock: Number(campaign.goldStock) || 0,
      resources: merchantResourceSnapshot(backpack),
    });
    if (delayMs > 0) await sleep(delayMs);
  }

  return {
    ok: traded > 0,
    traded,
    goldBefore: beforeGold,
    goldAfter: Number(backpack.gold) || beforeGold,
    reason,
    resetAtMs,
    backpack,
    campaign,
  };
}

async function runMerchantTrade({ presence, client, cost = MERCHANT_TRADE_COST, campaign = null, log = () => {} }) {
  await synchronizeMerchantPosition(presence, log);
  await navigateToMerchant(presence, log);
  try {
    await client.saveSpawn('world', 18, 11);
  } catch (error) {
    log('spawn_persist_failed', { reason: failureReason(error) });
  }
  return tradeMaximumGold(client, { cost, initialCampaign: campaign, log });
}

module.exports = {
  MERCHANT_APPROACH,
  MAINLAND_RETURNS,
  failureReason,
  spawnToMerchantPresenceState,
  synchronizeMerchantPosition,
  returnMerchantToMainland,
  navigateToMerchant,
  tradeMaximumGold,
  runMerchantTrade,
};
