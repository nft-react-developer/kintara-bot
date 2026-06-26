const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createShardResolver,
  rankServers,
} = require('../lib/shardSelection');

test('rankServers skips restricted shards below the configured public floor', () => {
  const ranked = rankServers([
    { id: 4, full: false, queueLength: 0 },
    { id: 7, full: true, queueLength: 0 },
    { id: 6, full: false, queueLength: 2 },
  ], { minShard: 6, bypass: false });

  assert.deepEqual(ranked.map((server) => server.id), [6, 7]);
});

test('rankServers bypass includes low shards for explicitly allowed accounts', () => {
  const ranked = rankServers([
    { id: 4, full: false, queueLength: 0 },
    { id: 6, full: false, queueLength: 2 },
  ], { minShard: 6, bypass: true });

  assert.deepEqual(ranked.map((server) => server.id), [4, 6]);
});

test('shard resolver chooses the first ranked shard accepted by gate-check', async () => {
  const client = {
    async servers() {
      return { servers: [
        { id: 6, full: false, queueLength: 0 },
        { id: 7, full: false, queueLength: 1 },
      ] };
    },
    async get(path) {
      if (path.includes('shard=6')) {
        const error = new Error('rejected');
        error.status = 403;
        throw error;
      }
      return { gate: 'ok' };
    },
  };
  const resolveShard = createShardResolver({ getClient: async () => client, fallbackShard: 's6' });

  assert.equal(await resolveShard({ force: true }), 's7');
});
