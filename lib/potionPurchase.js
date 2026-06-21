const { normalizePotionType, parsePotionQuantity } = require('./potionCommand');

const SHOP = Object.freeze({
  worldEntrance: Object.freeze({ x: -18.5, z: -27.5 }),
  shopSpawn: Object.freeze({ x: 0, z: 3 }),
  purchase: Object.freeze({ x: 1, z: -2 }),
  shopExit: Object.freeze({ x: 0, z: 4 }),
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function potionCount(backpack, potionType) {
  const count = Number(backpack?.[potionType]);
  return Number.isFinite(count) ? count : null;
}

function failureReason(error) {
  const value = error?.body?.error || error?.body?.message || error?.message || error?.error || error;
  return String(value || 'rejected').slice(0, 160);
}

async function synchronizePosition(presence, log = () => {}) {
  log('Synchronizing authoritative player position...');
  const state = await presence.waitForSelfState({ timeoutMs: 15000 });
  log(`Position synchronized region=${state.region} x=${state.x} z=${state.z}`);
  return state;
}

async function navigateToShop(presence, log = () => {}) {
  if (presence.region === 'alchemist_shop') {
    log(`Already inside alchemist_shop at x=${presence.pos.x} z=${presence.pos.z}`);
  } else if (presence.region === 'world') {
    const beforeTransition = presence.selfStateVersion || 0;
    log(`Walking to alchemist shop entrance x=${SHOP.worldEntrance.x} z=${SHOP.worldEntrance.z}`);
    const result = await presence.walkTo(SHOP.worldEntrance.x, SHOP.worldEntrance.z, {
      maxSec: 45,
      until: () => presence.region === 'alchemist_shop',
    });
    if (result === 'timeout') throw new Error('timed out while walking to alchemist shop entrance');
    await presence.waitForRegion('alchemist_shop', 12000);
    await presence.waitForSelfState({ region: 'alchemist_shop', afterVersion: beforeTransition, timeoutMs: 12000 });
    log(`Entered alchemist_shop at x=${presence.pos.x} z=${presence.pos.z}`);
  } else {
    const error = new Error(`unsupported starting region: ${presence.region || 'unknown'}`);
    error.code = 'UNSUPPORTED_REGION';
    throw error;
  }

  log(`Walking to potion counter x=${SHOP.purchase.x} z=${SHOP.purchase.z}`);
  const result = await presence.walkTo(SHOP.purchase.x, SHOP.purchase.z, { maxSec: 20 });
  if (result !== 'arrived') throw new Error('timed out while walking to potion counter');
  log('Arrived at potion counter');
}

async function buyPotions(client, potionType, quantity, { initialBackpack = null, log = () => {}, delayMs = 100 } = {}) {
  const normalizedType = normalizePotionType(potionType);
  const normalizedQuantity = parsePotionQuantity(quantity);
  if (!normalizedType) throw new Error(`invalid potion type: ${potionType}`);
  if (!normalizedQuantity) throw new Error(`invalid potion quantity: ${quantity}`);

  let purchased = 0;
  let backpack = initialBackpack;
  let lastCount = potionCount(backpack, normalizedType);
  let reason = null;

  for (let attempt = 1; attempt <= normalizedQuantity; attempt++) {
    log(`Buying ${normalizedType} ${attempt}/${normalizedQuantity}...`);
    let response;
    try {
      response = await client.alchemistPotionBuy(normalizedType, 1);
    } catch (error) {
      reason = failureReason(error);
      log(`Potion purchase stopped: ${reason}`);
      break;
    }
    if (!response || response.ok === false || response.error) {
      reason = failureReason(response?.error || response || 'rejected');
      log(`Potion purchase stopped: ${reason}`);
      break;
    }

    backpack = response.backpack || backpack;
    const nextCount = potionCount(backpack, normalizedType);
    if (lastCount != null && nextCount != null && nextCount <= lastCount) {
      reason = 'inventory did not increase after purchase';
      log(`Potion purchase stopped: ${reason}`);
      break;
    }
    purchased += lastCount != null && nextCount != null ? Math.max(1, nextCount - lastCount) : 1;
    if (nextCount != null) lastCount = nextCount;
    log(`Potion purchase accepted purchased=${Math.min(purchased, normalizedQuantity)}/${normalizedQuantity}`);
    if (attempt < normalizedQuantity && delayMs > 0) await sleep(delayMs);
  }

  return {
    requested: normalizedQuantity,
    purchased: Math.min(purchased, normalizedQuantity),
    potionType: normalizedType,
    complete: purchased >= normalizedQuantity,
    reason,
    backpack,
  };
}

async function leaveShop(presence, log = () => {}) {
  if (presence.region !== 'alchemist_shop') return;
  const beforeTransition = presence.selfStateVersion || 0;
  log(`Walking to alchemist shop exit x=${SHOP.shopExit.x} z=${SHOP.shopExit.z}`);
  const result = await presence.walkTo(SHOP.shopExit.x, SHOP.shopExit.z, {
    maxSec: 20,
    until: () => presence.region === 'world',
  });
  if (result === 'timeout') throw new Error('timed out while walking to alchemist shop exit');
  await presence.waitForRegion('world', 12000);
  await presence.waitForSelfState({ region: 'world', afterVersion: beforeTransition, timeoutMs: 12000 });
  log(`Returned to world at x=${presence.pos.x} z=${presence.pos.z}`);
}

async function runPotionPurchase({ presence, client, potionType, quantity, log = () => {} }) {
  await synchronizePosition(presence, log);
  let result = null;
  let operationError = null;
  try {
    await navigateToShop(presence, log);
    let initialBackpack = null;
    try { initialBackpack = (await client.me())?.backpack || null; } catch (error) {
      log(`Initial backpack refresh failed: ${failureReason(error)}`);
    }
    result = await buyPotions(client, potionType, quantity, { initialBackpack, log });
  } catch (error) {
    operationError = error;
  }

  let exitError = null;
  try {
    await leaveShop(presence, log);
  } catch (error) {
    exitError = error;
    log(`Failed to return to world: ${failureReason(error)}`);
  }

  if (operationError) throw operationError;
  if (exitError) {
    result.complete = false;
    result.reason = [result.reason, `return failed: ${failureReason(exitError)}`].filter(Boolean).join('; ');
  }
  return result;
}

module.exports = {
  SHOP,
  potionCount,
  synchronizePosition,
  navigateToShop,
  buyPotions,
  leaveShop,
  runPotionPurchase,
};
