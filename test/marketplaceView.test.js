const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatListingUnitPrice,
  MARKET_CATEGORIES,
  listingUnitPrice,
} = require('../lib/marketplaceView');

test('marketplace categories match the official server filter keys', () => {
  assert.deepEqual(MARKET_CATEGORIES.map(({ id }) => id), [
    'all', 'cat_gold', 'cat_mounts', 'cat_cosmetics', 'cat_materials',
    'cat_potions', 'cat_food', 'cat_keys', 'cat_pets', 'cat_furni',
  ]);
});

test('marketplace unit price is derived from total price and quantity', () => {
  assert.equal(listingUnitPrice({ currency: 'gold', quantity: 10, priceGold: 30 }), 3);
  assert.equal(listingUnitPrice({ currency: 'token', quantity: 4, priceUsd: 0.2 }), 0.05);
});

test('small unit prices from cheap listings preserve meaningful precision', () => {
  assert.equal(formatListingUnitPrice({ currency: 'gold', quantity: 4000, priceGold: 2 }), '0.0005g/unit');
  assert.equal(formatListingUnitPrice({ currency: 'gold', quantity: 668, priceGold: 1 }), '0.001497g/unit');
  assert.equal(formatListingUnitPrice({ currency: 'token', quantity: 4, priceUsd: 0.2 }), '$0.05/unit');
});
