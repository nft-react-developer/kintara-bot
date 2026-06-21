const test = require('node:test');
const assert = require('node:assert/strict');
const {
  availableMarketCategories,
  filterListingsByCategory,
  listingUnitPrice,
  marketCategoryForItem,
  sortListingsCheapest,
} = require('../lib/marketplaceView');

test('marketplace items are grouped into useful buy categories', () => {
  assert.equal(marketCategoryForItem('wood'), 'materials');
  assert.equal(marketCategoryForItem('cooked_fish_meat'), 'food');
  assert.equal(marketCategoryForItem('potion_health'), 'potions');
  assert.equal(marketCategoryForItem('wild_sword'), 'equipment');
  assert.equal(marketCategoryForItem('mount_wolf'), 'mounts');
  assert.equal(marketCategoryForItem('cosmetic_crown'), 'cosmetics');
  assert.equal(marketCategoryForItem('furniture_marble_wall'), 'furniture');
  assert.equal(marketCategoryForItem('gold'), 'gold');
  assert.equal(marketCategoryForItem('unknown_collectible'), 'other');
});

test('category filters only return matching listings', () => {
  const listings = [
    { itemType: 'wood' },
    { itemType: 'fish' },
    { itemType: 'potion_health' },
  ];
  assert.deepEqual(filterListingsByCategory(listings, 'food'), [{ itemType: 'fish' }]);
  assert.deepEqual(filterListingsByCategory(listings, 'all'), listings);
  assert.deepEqual(availableMarketCategories(listings).map(({ id }) => id), ['all', 'materials', 'food', 'potions']);
});

test('cheapest sorting compares unit prices without mixing currencies', () => {
  const listings = [
    { id: 1, currency: 'gold', quantity: 10, priceGold: 30 },
    { id: 2, currency: 'token', quantity: 10, priceUsd: 1 },
    { id: 3, currency: 'gold', quantity: 2, priceGold: 4 },
    { id: 4, currency: 'token', quantity: 4, priceUsd: 0.2 },
  ];
  assert.equal(listingUnitPrice(listings[0]), 3);
  assert.deepEqual(sortListingsCheapest(listings).map(({ id }) => id), [3, 1, 4, 2]);
});
