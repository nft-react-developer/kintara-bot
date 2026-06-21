const { normalizePotionType, parsePotionQuantity } = require('./potionCommand');

const SHOP = Object.freeze({
  worldEntrance: Object.freeze({ x: -18.5, z: -27.5 }),
  shopSpawn: Object.freeze({ x: 0, z: 3 }),
  purchase: Object.freeze({ x: 1, z: -2 }),
  shopExit: Object.freeze({ x: 0, z: 4 }),
});

const MAINLAND_OFFSET = -30.5;
const ALCHEMIST_OFFSET = -4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function potionCount(backpack, potionType) {
  const count = Number(backpack?.[potionType]);
  return Number.isFinite(count) ? count : null;
}

function failureReason(error) {
  const value = error?.body?.error || error?.body?.message || error?.message || error?.error || error;
  return String(value || 'rejected').slice(0, 160);
}

function spawnToPresenceState(spawn) {
  const realm = String(spawn?.realm || '');
  const col = Number(spawn?.col);
  const row = Number(spawn?.row);
  if (!Number.isFinite(col) || !Number.isFinite(row)) {
    throw new Error('player spawn is missing valid coordinates');
  }
  if (realm === 'world') {
    return { region: 'world', x: MAINLAND_OFFSET + col, y: 0.25, z: MAINLAND_OFFSET + row, ry: 0 };
  }
  if (realm === 'alchemistShop' || realm === 'alchemist_shop') {
    return { region: 'alchemist_shop', x: ALCHEMIST_OFFSET + col, y: 0.41, z: ALCHEMIST_OFFSET + row, ry: 0 };
  }
  const error = new Error(`unsupported starting region: ${realm || 'unknown'}`);
  error.code = 'UNSUPPORTED_REGION';
  throw error;
}

function presencePositionToSpawn(region, position) {
  const x = Number(position?.x);
  const z = Number(position?.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error('invalid presence position');
  if (region === 'world') return { realm: 'world', col: Math.round(x - MAINLAND_OFFSET), row: Math.round(z - MAINLAND_OFFSET) };
  if (region === 'alchemist_shop') return { realm: 'alchemistShop', col: Math.round(x - ALCHEMIST_OFFSET), row: Math.round(z - ALCHEMIST_OFFSET) };
  throw new Error(`unsupported spawn region: ${region || 'unknown'}`);
}

async function persistCurrentSpawn(client, presence, log = () => {}) {
  try {
    const spawn = presencePositionToSpawn(presence.region, presence.pos);
    await client.saveSpawn(spawn.realm, spawn.col, spawn.row);
    log(`Persisted position realm=${spawn.realm} col=${spawn.col} row=${spawn.row}`);
  } catch (error) {
    log(`Position persistence failed: ${failureReason(error)}`);
  }
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
    await persistCurrentSpawn(client, presence, log);
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
    if (presence.region === 'world') await persistCurrentSpawn(client, presence, log);
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
  spawnToPresenceState,
  presencePositionToSpawn,
  persistCurrentSpawn,
};
