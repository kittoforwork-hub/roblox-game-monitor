import assert from 'node:assert/strict';
import worker from '../worker/index.js';

const originalFetch = globalThis.fetch;
const fixtures = {
  '123': { universeId: 9001 },
  '456': { universeId: 9002 }
};
globalThis.fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === 'apis.roblox.com' && url.pathname.includes('/universes/v1/places/')) {
    const placeId = url.pathname.match(/places\/(\d+)\/universe/)?.[1];
    if (!fixtures[placeId]) return new Response(JSON.stringify({ errors: [{ message: 'not found' }] }), { status: 404 });
    return new Response(JSON.stringify(fixtures[placeId]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.hostname === 'games.roblox.com' && url.pathname === '/v1/games') {
    const ids = (url.searchParams.get('universeIds') || '').split(',');
    const byId = {
      '9001': { id: 9001, name: 'Test Night', playing: 47, maxPlayers: 50, visits: 12000, isPlayable: true, creator: { id: 321, name: 'Studio Test' }, updated: '2026-10-25T00:00:00.000Z' },
      '9002': { id: 9002, name: 'Test Obby', playing: 9, maxPlayers: 20, visits: 4500, isPlayable: true, creator: { id: 654, name: 'Builder Test' }, updated: '2026-10-24T00:00:00.000Z' }
    };
    return new Response(JSON.stringify({ data: ids.map((id) => byId[id]).filter(Boolean) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.hostname === 'thumbnails.roblox.com') {
    const ids = (url.searchParams.get('universeIds') || '').split(',');
    return new Response(JSON.stringify({ data: ids.map((id) => ({ targetId: Number(id), state: 'Completed', imageUrl: `https://tr.rbxcdn.com/${id}/150/150/Image/Png` })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('{}', { status: 404 });
};

try {
  const env = { APP_VERSION: '2.0.0', MAX_TRACKED_GAMES: '10' };
  const ctx = { waitUntil() {} };
  const batchRes = await worker.fetch(new Request('https://monitor.example/api/games?placeIds=123,456'), env, ctx);
  assert.equal(batchRes.status, 200);
  const batch = await batchRes.json();
  assert.equal(batch.games.length, 2);
  assert.equal(batch.games[0].name, 'Test Night');
  assert.equal(batch.games[0].playing, 47);
  assert.equal(batch.games[1].universeId, 9002);
  assert.equal(batch.storage, 'local');

  const singleRes = await worker.fetch(new Request('https://monitor.example/api/game?placeId=123'), env, ctx);
  assert.equal(singleRes.status, 200);
  const single = await singleRes.json();
  assert.equal(single.placeId, '123');
  assert.equal(single.creatorName, 'Studio Test');

  const healthRes = await worker.fetch(new Request('https://monitor.example/api/health'), env, ctx);
  const health = await healthRes.json();
  assert.equal(health.ok, true);
  assert.equal(health.storage.d1, false);

  const historyRes = await worker.fetch(new Request('https://monitor.example/api/history?placeId=123&range=24h'), env, ctx);
  const history = await historyRes.json();
  assert.equal(history.source, 'local');
  assert.deepEqual(history.samples, []);

  const d1Statements = [];
  const mockD1 = {
    prepare(sql) {
      return {
        sql,
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (this.sql.includes('INSERT INTO request_limits')) return { hits: 1 };
          return { healthy: 1 };
        },
        async all() {
          return { results: [{ ts: Date.now() - 60_000, playing: 31, maxPlayers: 50, visits: 11000, sampleCount: 2 }] };
        },
        async run() { return { success: true }; }
      };
    },
    async batch(statements) { d1Statements.push(...statements.map((statement) => statement.sql)); return []; }
  };
  const d1Env = { ...env, DB: mockD1 };
  const d1BatchRes = await worker.fetch(new Request('https://monitor.example/api/games?placeIds=123,456'), d1Env, ctx);
  const d1Batch = await d1BatchRes.json();
  assert.equal(d1Batch.storage, 'd1');
  assert.equal(d1Statements.filter((sql) => sql.includes('INSERT INTO game_snapshots')).length, 2);
  const d1Health = await (await worker.fetch(new Request('https://monitor.example/api/health'), d1Env, ctx)).json();
  assert.equal(d1Health.storage.d1, true);
  const d1History = await (await worker.fetch(new Request('https://monitor.example/api/history?placeId=123&range=24h'), d1Env, ctx)).json();
  assert.equal(d1History.source, 'd1');
  assert.equal(d1History.samples[0].playing, 31);

  const invalidRes = await worker.fetch(new Request('https://monitor.example/api/game?placeId=abc'), env, ctx);
  assert.equal(invalidRes.status, 400);

  const partialRes = await worker.fetch(new Request('https://monitor.example/api/games?placeIds=123,777'), env, ctx);
  const partial = await partialRes.json();
  assert.equal(partial.games[0].ok, true);
  assert.equal(partial.games[1].ok, false);

  console.log('Worker smoke tests passed: batch/single API, D1 persistence/history, health, fallback, validation, and partial failure.');
} finally {
  globalThis.fetch = originalFetch;
}
