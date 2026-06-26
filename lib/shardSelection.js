const { config } = require('../config');

const DEFAULT_PUBLIC_MIN_SHARD = 6;

function configuredMinShard() {
  return Math.max(
    1,
    parseInt(process.env.KINTARA_MIN_SHARD || String(DEFAULT_PUBLIC_MIN_SHARD), 10) || DEFAULT_PUBLIC_MIN_SHARD
  );
}

function allowLowServers() {
  return process.env.KINTARA_ALLOW_LOW_SERVERS === '1';
}

function shardName(id) {
  const number = Number(id) | 0;
  return number > 0 ? `s${number}` : null;
}

function normalizeServers(servers) {
  return (servers || []).filter((server) => server && server.id != null && Number(server.id) > 0);
}

function rankServers(servers, { minShard = configuredMinShard(), bypass = allowLowServers() } = {}) {
  const list = normalizeServers(servers);
  const eligible = bypass ? list : list.filter((server) => Number(server.id) >= minShard);
  return [...(eligible.length ? eligible : list)].sort((left, right) => {
    const leftFull = !!left.full;
    const rightFull = !!right.full;
    if (leftFull !== rightFull) return leftFull ? 1 : -1;
    return Number(left.queueLength || 0) - Number(right.queueLength || 0);
  });
}

async function shardGateOk(client, id) {
  try {
    const result = await client.get(`/api/auth/gate-check?shard=${Number(id) | 0}`);
    return result && result.gate === 'ok';
  } catch (error) {
    if (error && error.status === 403) return false;
    return null;
  }
}

function createShardResolver({
  getClient,
  cacheMs = 60000,
  fallbackShard = config.shard || 's6',
} = {}) {
  let cache = { ts: 0, shard: null };

  return async function resolveShard({ force = false } = {}) {
    if (!force && Date.now() - cache.ts < cacheMs && cache.shard) return cache.shard;
    if (typeof getClient !== 'function') return fallbackShard;

    try {
      const client = await getClient();
      const response = await client.servers();
      const ranked = rankServers(response?.servers);
      if (!ranked.length) return fallbackShard;

      if (allowLowServers()) {
        const shard = shardName(ranked[0].id);
        cache = { ts: Date.now(), shard };
        return shard;
      }

      for (const server of ranked) {
        const ok = await shardGateOk(client, server.id);
        if (ok === true) {
          const shard = shardName(server.id);
          cache = { ts: Date.now(), shard };
          return shard;
        }
      }

      const fallbackRanked = shardName(ranked[0].id) || fallbackShard;
      cache = { ts: Date.now(), shard: fallbackRanked };
      return fallbackRanked;
    } catch {
      return fallbackShard;
    }
  };
}

module.exports = {
  DEFAULT_PUBLIC_MIN_SHARD,
  allowLowServers,
  configuredMinShard,
  createShardResolver,
  rankServers,
  shardGateOk,
  shardName,
};
