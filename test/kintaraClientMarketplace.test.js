const test = require('node:test');
const assert = require('node:assert/strict');
const { KintaraClient } = require('../lib/kintaraClient');

test('marketplace listing request forwards official sort, currency, and category filters', async () => {
  const client = new KintaraClient({ apiBase: 'https://example.test' });
  client.get = async (requestPath) => requestPath;

  const requestPath = await client.marketplaceListings({
    sort: 'cheap',
    currency: 'all',
    category: 'cat_potions',
    limit: 20,
    offset: 0,
  });

  assert.equal(requestPath, '/api/marketplace/listings?limit=20&offset=0&sort=cheap&currency=all&category=cat_potions');
});
