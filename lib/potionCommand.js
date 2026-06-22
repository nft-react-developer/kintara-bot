const POTION_TYPES = Object.freeze({
  health: 'potion_health',
  shield: 'potion_shield',
  strength: 'potion_strength',
  poison: 'potion_poison',
});

const POTION_LABELS = Object.freeze({
  potion_health: 'Health',
  potion_shield: 'Shield',
  potion_strength: 'Strength',
  potion_poison: 'Poison',
});

const POTION_RECIPES = Object.freeze({
  potion_health: Object.freeze({ wood: 60 }),
  potion_shield: Object.freeze({ stone: 50 }),
  potion_strength: Object.freeze({ coal: 40 }),
  potion_poison: Object.freeze({ wood: 50, coal: 20 }),
});

const POTION_RESOURCE_LABELS = Object.freeze({
  wood: '🪵 Wood',
  stone: '🪨 Stone',
  coal: '⚫ Coal',
  metal: '🔩 Metal',
  gold: '🪙 Gold',
  fish: '🎣 Fish',
  cooked_fish_meat: '🍳 Cooked fish',
  raw_chicken: '🐔 Raw chicken',
  cooked_chicken: '🍗 Cooked chicken',
  potion_health: '❤️ Health potion',
  potion_shield: '🛡 Shield potion',
  potion_strength: '💪 Strength potion',
  potion_poison: '☠️ Poison potion',
});

function normalizePotionType(value) {
  const key = String(value || '').trim().toLowerCase();
  if (POTION_TYPES[key]) return POTION_TYPES[key];
  return Object.values(POTION_TYPES).includes(key) ? key : null;
}

function parsePotionQuantity(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const quantity = Number(text);
  return Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 999 ? quantity : null;
}

function potionResourceSnapshot(backpack = {}) {
  return Object.fromEntries(
    Object.keys(POTION_RESOURCE_LABELS).map((key) => [key, Math.max(0, Number(backpack[key]) || 0)])
  );
}

function formatPotionResources(resources = {}) {
  const value = (key) => Math.max(0, Number(resources[key]) || 0).toLocaleString('en-US');
  return [
    '🎒 <b>Available resources</b>',
    '🧪 <b>Current potions</b>',
    `❤️ Health: <b>${value('potion_health')}</b> | 🛡 Shield: <b>${value('potion_shield')}</b>`,
    `💪 Strength: <b>${value('potion_strength')}</b> | ☠️ Poison: <b>${value('potion_poison')}</b>`,
    '</b>',
    '⛺ <b>Current resources</b>',
    `🪵 Wood: <b>${value('wood')}</b> | 🪨 Stone: <b>${value('stone')}</b> | ⚫ Coal: <b>${value('coal')}</b>`,
    `🔩 Metal: <b>${value('metal')}</b> | 🪙 Gold: <b>${value('gold')}</b>`,
    `🎣 Fish: <b>${value('fish')}</b> | 🍳 Cooked fish: <b>${value('cooked_fish_meat')}</b>`,
    `🐔 Raw chicken: <b>${value('raw_chicken')}</b> | 🍗 Cooked chicken: <b>${value('cooked_chicken')}</b>`,
  ].join('\n');
}

function parsePotionCatalogSource(source) {
  const text = String(source || '');
  const start = text.indexOf('const ALCHEMIST_POTION_OFFERS = [');
  if (start < 0) throw new Error('alchemist potion offers not found in game client');
  const end = text.indexOf('\n];', start);
  if (end < 0) throw new Error('alchemist potion offers are incomplete in game client');
  const block = text.slice(start, end);
  const catalog = {};
  const offerPattern = /type:\s*['"](potion_(?:health|shield|strength|poison))['"]/g;
  let match;
  while ((match = offerPattern.exec(block))) {
    const objectStart = block.lastIndexOf('{', match.index);
    let depth = 0;
    let objectEnd = -1;
    for (let i = objectStart; i < block.length; i++) {
      if (block[i] === '{') depth++;
      if (block[i] === '}' && --depth === 0) {
        objectEnd = i + 1;
        break;
      }
    }
    if (objectStart < 0 || objectEnd < 0) continue;
    const offer = block.slice(objectStart, objectEnd);
    const costBlock = offer.match(/cost:\s*\{([^}]*)\}/)?.[1] || '';
    const cost = {};
    for (const pair of costBlock.matchAll(/(wood|stone|coal|gold):\s*(\d+)/g)) {
      const amount = Number(pair[2]);
      if (amount > 0) cost[pair[1]] = amount;
    }
    catalog[match[1]] = Object.freeze({
      cost: Object.freeze(cost),
      available: !/soldOut:\s*true/.test(offer),
    });
  }
  for (const type of Object.values(POTION_TYPES)) {
    if (!catalog[type]) throw new Error(`missing ${type} offer in game client`);
  }
  return Object.freeze(catalog);
}

async function fetchPotionCatalog(apiBase, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${String(apiBase || '').replace(/\/$/, '')}/game.js?potions=${Date.now()}`;
    const response = await fetchImpl(url, {
      headers: { Accept: 'text/javascript', 'Cache-Control': 'no-cache' },
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`game client request failed with status ${response?.status || '?'}`);
    return parsePotionCatalogSource(await response.text());
  } finally {
    clearTimeout(timer);
  }
}

function formatPotionRecipes(catalog = null) {
  const recipe = (type) => catalog?.[type]?.cost || POTION_RECIPES[type];
  const cost = (type) => Object.entries(recipe(type))
    .map(([key, amount]) => `${amount} ${key}`)
    .join(' + ');
  const availability = (type) => catalog?.[type]?.available === false ? ' <i>(sold out)</i>' : '';
  return [
    '⚗️ <b>Cost per potion</b>',
    `❤️ Health: <b>${cost(POTION_TYPES.health)}</b>${availability(POTION_TYPES.health)}`,
    `🛡 Shield: <b>${cost(POTION_TYPES.shield)}</b>${availability(POTION_TYPES.shield)}`,
    `💪 Strength: <b>${cost(POTION_TYPES.strength)}</b>${availability(POTION_TYPES.strength)}`,
    `☠️ Poison: <b>${cost(POTION_TYPES.poison)}</b>${availability(POTION_TYPES.poison)}`,
  ].join('\n');
}

module.exports = {
  POTION_TYPES,
  POTION_LABELS,
  POTION_RECIPES,
  POTION_RESOURCE_LABELS,
  normalizePotionType,
  parsePotionQuantity,
  potionResourceSnapshot,
  parsePotionCatalogSource,
  fetchPotionCatalog,
  formatPotionResources,
  formatPotionRecipes,
};
