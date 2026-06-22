const test = require('node:test');
const assert = require('node:assert/strict');
const { potionSelectionButtons } = require('../tools/telegram-bot');
const {
  POTION_RECIPES,
  potionResourceSnapshot,
  parsePotionCatalogSource,
  formatPotionResources,
  formatPotionRecipes,
} = require('../lib/potionCommand');

test('potion keyboard exposes every selection and confirmation callback', () => {
  const callbacks = potionSelectionButtons().flat().map((button) => button.data);
  for (const expected of [
    'pt:type:health', 'pt:type:shield', 'pt:type:strength', 'pt:type:poison',
    'pt:qty:10', 'pt:qty:25', 'pt:qty:50', 'pt:qty:100',
    'pt:custom', 'pt:confirm', 'pt:cancel',
  ]) {
    assert.ok(callbacks.includes(expected), `missing ${expected}`);
  }
  assert.ok(callbacks.every((value) => Buffer.byteLength(value) <= 64));
});

test('potion keyboard blocks offers reported unavailable by the live catalog', () => {
  const buttons = potionSelectionButtons({
    catalog: { potion_poison: { available: false } },
  }).flat();
  const poison = buttons.find((button) => button.data.includes('poison'));
  assert.equal(poison.data, 'pt:unavailable:poison');
  assert.match(poison.text, /unavailable|Poison/i);
});

test('potion command reports every known resource counter', () => {
  const resources = potionResourceSnapshot({
    wood: 1234,
    stone: 50,
    coal: 40,
    metal: 7,
    gold: 3,
    fish: 12,
    cooked_fish_meat: 8,
    raw_chicken: 2,
    cooked_chicken: 1,
    potion_health: 11,
    potion_shield: 6,
    potion_strength: 4,
    potion_poison: 2,
  });
  const summary = formatPotionResources(resources);
  for (const expected of [
    'Current potions', 'Health: <b>11', 'Shield: <b>6', 'Strength: <b>4', 'Poison: <b>2',
    '1,234', 'Stone', 'Coal', 'Metal', 'Gold', 'Fish', 'Cooked fish', 'Raw chicken', 'Cooked chicken',
  ]) {
    assert.match(summary, new RegExp(expected));
  }
});

test('potion recipe summary uses the current alchemist costs', () => {
  assert.deepEqual(POTION_RECIPES.potion_health, { wood: 60 });
  assert.deepEqual(POTION_RECIPES.potion_shield, { stone: 50 });
  assert.deepEqual(POTION_RECIPES.potion_strength, { coal: 40 });
  assert.deepEqual(POTION_RECIPES.potion_poison, { wood: 50, coal: 20 });
  const summary = formatPotionRecipes();
  for (const expected of ['60 wood', '50 stone', '40 coal', '50 wood + 20 coal']) {
    assert.ok(summary.includes(expected), `missing ${expected}`);
  }
  assert.ok(!summary.includes('sold out'));
});

test('potion catalog availability is parsed from the current game client source', () => {
  const catalog = parsePotionCatalogSource(`
const ALCHEMIST_POTION_OFFERS = [
  { type: 'potion_health', cost: { wood: 60, stone: 0, coal: 0 } },
  { type: 'potion_shield', cost: { wood: 0, stone: 50, coal: 0 } },
  { type: 'potion_strength', cost: { wood: 0, stone: 0, coal: 40 } },
  { type: 'potion_poison', cost: { wood: 50, stone: 0, coal: 20 }, soldOut: true },
];
  `);
  assert.deepEqual(catalog.potion_health, { cost: { wood: 60 }, available: true });
  assert.deepEqual(catalog.potion_poison, { cost: { wood: 50, coal: 20 }, available: false });
  assert.match(formatPotionRecipes(catalog), /Poison:.*sold out/);
});
