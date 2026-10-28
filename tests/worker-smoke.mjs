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

const ctx = { waitUntil() {} };
const env = { APP_VERSION: '2.1.0', MAX_TRACKED_GAMES: '10' };

function makeMockD1({ eventRows = [], playerRows = [] } = {}) {
  const eventIds = new Set();
  const statementsSeen = [];
  return {
    eventIds,
    statementsSeen,
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (this.sql.includes('INSERT INTO request_limits')) return { hits: 1 };
          if (this.sql.includes('COUNT(*) AS activeCount')) return { activeCount: 1 };
          if (this.sql.includes('player_events')) return { healthy: 1 };
          return { healthy: 1 };
        },
        async all() {
          if (this.sql.includes('FROM player_sessions')) return { results: playerRows };
          if (this.sql.includes('FROM player_events')) return { results: eventRows };
          return { results: [{ ts: Date.now() - 60_000, playing: 31, maxPlayers: 50, visits: 11000, sampleCount: 2 }] };
        },
        async run() { return { success: true, meta: { changes: 1 } }; }
      };
      return statement;
    },
    async batch(statements) {
      return statements.map((statement) => {
        statementsSeen.push({ sql: statement.sql, values: statement.values });
        if (statement.sql.includes('INSERT INTO player_events')) {
          const eventId = String(statement.values[0]);
          if (eventIds.has(eventId)) return { success: true, meta: { changes: 0 } };
          eventIds.add(eventId);
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 1 } };
      });
    }
  };
}

try {
  // Existing dashboard APIs continue working without D1 (browser local fallback).
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
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.ok, true);
  assert.equal(health.version, '2.1.0');
  assert.equal(health.storage.d1, false);
  assert.equal(health.telemetry.configured, false);

  const historyRes = await worker.fetch(new Request('https://monitor.example/api/history?placeId=123&range=24h'), env, ctx);
  assert.equal(historyRes.status, 200);
  const history = await historyRes.json();
  assert.equal(history.source, 'local');
  assert.deepEqual(history.samples, []);

  const invalidRes = await worker.fetch(new Request('https://monitor.example/api/game?placeId=abc'), env, ctx);
  assert.equal(invalidRes.status, 400);
  const malformedBatch = await worker.fetch(new Request('https://monitor.example/api/games?placeIds=123,abc'), env, ctx);
  assert.equal(malformedBatch.status, 400);

  const d1Statements = [];
  const mockD1 = {
    prepare(sql) {
      return {
        sql,
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() { if (this.sql.includes('INSERT INTO request_limits')) return { hits: 1 }; return { healthy: 1 }; },
        async all() { return { results: [{ ts: Date.now() - 60_000, playing: 31, maxPlayers: 50, visits: 11000, sampleCount: 2 }] }; },
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
  assert.equal(d1Health.telemetry.schemaReady, true);
  const d1History = await (await worker.fetch(new Request('https://monitor.example/api/history?placeId=123&range=24h'), d1Env, ctx)).json();
  assert.equal(d1History.source, 'd1');
  assert.equal(d1History.samples[0].playing, 31);

  const partialRes = await worker.fetch(new Request('https://monitor.example/api/games?placeIds=123,777'), d1Env, ctx);
  const partial = await partialRes.json();
  assert.equal(partial.games[0].ok, true);
  assert.equal(partial.games[1].ok, false);

  // Telemetry rejects unauthenticated requests and fails clearly when storage is absent.
  const noToken = await worker.fetch(new Request('https://monitor.example/api/roblox/player-events', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: [] })
  }), { ...env, ROBLOX_INGEST_TOKEN: 'secret-token-that-is-not-short-1234567890' }, ctx);
  assert.equal(noToken.status, 401);
  const noStorage = await worker.fetch(new Request('https://monitor.example/api/roblox/player-events', {
    method: 'POST', headers: { Authorization: 'Bearer secret-token-that-is-not-short-1234567890', 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: 'event-no-db-001', eventType: 'join', placeId: '123', userId: '456', jobId: 'server-a' })
  }), { ...env, ROBLOX_INGEST_TOKEN: 'secret-token-that-is-not-short-1234567890' }, ctx);
  assert.equal(noStorage.status, 503);

  const now = Date.now();
  const telemetryDb = makeMockD1({
    eventRows: [{ eventId: 'event-join-0001', eventType: 'join', placeId: '123', userId: '456', username: 'Tester', occurredAt: now }],
    playerRows: [{ placeId: '123', jobId: 'job-a', userId: '456', username: 'Tester', joinedAt: now, lastEventAt: now }]
  });
  const telemetryEnv = { ...env, DB: telemetryDb, ROBLOX_INGEST_TOKEN: 'secret-token-that-is-not-short-1234567890', TELEMETRY_REQUEST_LIMIT: '300' };
  const payload = { events: [
    { eventId: 'event-join-0001', eventType: 'join', placeId: '123', universeId: '9001', jobId: 'job-a', userId: '456', username: 'Tester', occurredAt: now - 10_000 },
    { eventId: 'event-leave-0002', eventType: 'leave', placeId: '123', universeId: '9001', jobId: 'job-a', userId: '456', username: 'Tester', occurredAt: now }
  ] };
  const ingestRes = await worker.fetch(new Request('https://monitor.example/api/roblox/player-events', {
    method: 'POST', headers: { Authorization: 'Bearer secret-token-that-is-not-short-1234567890', 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  }), telemetryEnv, ctx);
  assert.equal(ingestRes.status, 200);
  const ingest = await ingestRes.json();
  assert.equal(ingest.ok, true);
  assert.equal(ingest.accepted, 2);
  assert.equal(ingest.received, 2);
  assert.equal(telemetryDb.statementsSeen.filter((entry) => entry.sql.includes('INSERT INTO player_events')).length, 2);
  const sessionStatements = telemetryDb.statementsSeen.filter((entry) => entry.sql.includes('INSERT INTO player_sessions'));
  assert.equal(sessionStatements.length, 2);
  assert.ok(sessionStatements.every((entry) => entry.sql.includes('WHERE EXISTS (SELECT 1 FROM player_events WHERE event_id = ? AND batch_id = ?)')));

  // Retries with the same eventId are idempotent and must not replay state transitions.
  const duplicateRes = await worker.fetch(new Request('https://monitor.example/api/roblox/player-events', {
    method: 'POST', headers: { Authorization: 'Bearer secret-token-that-is-not-short-1234567890', 'Content-Type': 'application/json' }, body: JSON.stringify({ events: [payload.events[0]] })
  }), telemetryEnv, ctx);
  assert.equal(duplicateRes.status, 200);
  const duplicate = await duplicateRes.json();
  assert.equal(duplicate.accepted, 0);
  assert.equal(duplicate.duplicates, 1);

  const invalidEventRes = await worker.fetch(new Request('https://monitor.example/api/roblox/player-events', {
    method: 'POST', headers: { Authorization: 'Bearer secret-token-that-is-not-short-1234567890', 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: 'event-invalid-001', eventType: 'kick', placeId: '123', userId: '456', jobId: 'job-a' })
  }), telemetryEnv, ctx);
  assert.equal(invalidEventRes.status, 400);
  const wrongContentType = await worker.fetch(new Request('https://monitor.example/api/roblox/player-events', {
    method: 'POST', headers: { Authorization: 'Bearer secret-token-that-is-not-short-1234567890', 'Content-Type': 'text/plain' }, body: '{}'
  }), telemetryEnv, ctx);
  assert.equal(wrongContentType.status, 415);

  const activeRes = await worker.fetch(new Request('https://monitor.example/api/roblox/players?placeId=123', {
    headers: { Authorization: 'Bearer secret-token-that-is-not-short-1234567890' }
  }), telemetryEnv, ctx);
  assert.equal(activeRes.status, 200);
  const active = await activeRes.json();
  assert.equal(active.activeCount, 1);
  assert.equal(active.players[0].userId, '456');

  const eventReadRes = await worker.fetch(new Request('https://monitor.example/api/roblox/player-events?placeId=123&limit=20', {
    headers: { Authorization: 'Bearer secret-token-that-is-not-short-1234567890' }
  }), telemetryEnv, ctx);
  assert.equal(eventReadRes.status, 200);
  const eventRead = await eventReadRes.json();
  assert.equal(eventRead.events.length, 1);
  assert.equal(eventRead.events[0].username, 'Tester');

  console.log('Worker smoke tests passed: dashboard routes, D1 history, validation, partial failure, telemetry auth, ingestion, idempotency, and protected reads.');
} finally {
  globalThis.fetch = originalFetch;
}
