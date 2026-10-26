const APP_VERSION = '2.0.0';
const MAX_TRACKED = 10;
const MAX_HISTORY_DAYS = 30;
const DEFAULT_RATE_LIMIT = 50;
const WINDOW_MS = 60_000;

class UpstreamError extends Error {
  constructor(message, status = 502, code = 'UPSTREAM_ERROR') {
    super(message); this.status = status; this.code = code;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }
  });
}
function withCors(request, response, env) {
  const origin = request.headers.get('Origin');
  const allowed = env.ALLOWED_ORIGIN || new URL(request.url).origin;
  if (origin && origin === allowed) {
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', allowed);
    headers.set('Vary', 'Origin');
    headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Accept');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  return response;
}
function positivePlaceId(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,20}$/.test(text)) return null;
  try { return BigInt(text) > 0n ? text : null; } catch (_) { return null; }
}
function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}
function retryDelay(response, attempt) {
  const header = Number(response.headers.get('Retry-After'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 2500);
  return attempt === 0 ? 450 : 1000;
}
async function fetchPublicJson(url) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'Roblox-Live-Operations-Monitor/2.0' },
        signal: AbortSignal.timeout(10_000),
        cf: { cacheTtl: 20, cacheEverything: true }
      });
    } catch (error) {
      lastError = new UpstreamError('เชื่อมต่อ Roblox API ไม่สำเร็จหรือหมดเวลา', 502, 'UPSTREAM_NETWORK_ERROR');
      if (attempt === 0) { await new Promise((resolve) => setTimeout(resolve, retryDelay({ headers: new Headers() }, attempt))); continue; }
      break;
    }
    if ((response.status === 429 || response.status >= 500) && attempt === 0) {
      lastError = new UpstreamError(response.status === 429 ? 'Roblox API จำกัดอัตราการเรียก กรุณารอสักครู่' : `Roblox API ตอบกลับ ${response.status}`, response.status === 429 ? 429 : 502, response.status === 429 ? 'ROBLOX_RATE_LIMITED' : 'ROBLOX_UPSTREAM_ERROR');
      await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
      continue;
    }
    if (!response.ok) {
      const status = response.status === 404 ? 404 : response.status === 429 ? 429 : 502;
      const message = response.status === 404 ? 'ไม่พบเกมหรือข้อมูลไม่เปิดเผยต่อสาธารณะ' : response.status === 429 ? 'Roblox API จำกัดอัตราการเรียก กรุณารอสักครู่' : `Roblox API ตอบกลับ HTTP ${response.status}`;
      throw new UpstreamError(message, status, response.status === 429 ? 'ROBLOX_RATE_LIMITED' : response.status === 404 ? 'GAME_NOT_FOUND' : 'ROBLOX_UPSTREAM_ERROR');
    }
    try { return await response.json(); }
    catch (_) { throw new UpstreamError('Roblox API ส่งข้อมูลที่อ่านไม่ได้กลับมา', 502, 'INVALID_UPSTREAM_JSON'); }
  }
  throw lastError || new UpstreamError('Roblox API ไม่พร้อมใช้งาน', 502, 'UPSTREAM_ERROR');
}
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try { results[index] = await mapper(items[index], index); }
      catch (error) { results[index] = { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
async function resolveUniverse(placeId) {
  const data = await fetchPublicJson(`https://apis.roblox.com/universes/v1/places/${encodeURIComponent(placeId)}/universe`);
  const universeId = positivePlaceId(data && data.universeId);
  if (!universeId) throw new UpstreamError('ไม่สามารถแปลง Place ID เป็น Universe ID ได้', 404, 'UNIVERSE_NOT_FOUND');
  return universeId;
}
function normalizeGame(requestedPlaceId, universeId, source, iconUrl) {
  const creator = source.creator && typeof source.creator === 'object' ? source.creator : {};
  const playableValue = typeof source.isPlayable === 'boolean' ? source.isPlayable : typeof source.playable === 'boolean' ? source.playable : null;
  return {
    placeId: String(requestedPlaceId),
    universeId: safeNumber(source.id) ?? safeNumber(universeId),
    name: typeof source.name === 'string' && source.name.trim() ? source.name.trim() : `Place ${requestedPlaceId}`,
    description: typeof source.description === 'string' ? source.description : '',
    creatorName: typeof creator.name === 'string' ? creator.name : '',
    creatorId: safeNumber(creator.id),
    isPlayable: playableValue,
    playing: safeNumber(source.playing),
    maxPlayers: safeNumber(source.maxPlayers),
    visits: safeNumber(source.visits),
    iconUrl: typeof iconUrl === 'string' && iconUrl.startsWith('https://') ? iconUrl : '',
    updatedAt: source.updated || null,
    checkedAt: Date.now()
  };
}
async function getGames(placeIds, env) {
  const resolved = await mapWithConcurrency(placeIds, 4, async (placeId) => ({ placeId, universeId: await resolveUniverse(placeId) }));
  const resolveErrors = new Map();
  const valid = [];
  resolved.forEach((item, index) => {
    if (item && item.error) resolveErrors.set(placeIds[index], item.error);
    else if (item && item.universeId) valid.push(item);
  });
  if (!valid.length) {
    return placeIds.map((placeId) => ({ ok: false, placeId, error: resolveErrors.get(placeId)?.message || 'ไม่พบข้อมูลเกมจาก Roblox', code: resolveErrors.get(placeId)?.code || 'GAME_NOT_FOUND' }));
  }

  const universeIds = [...new Set(valid.map((item) => item.universeId))];
  let details = [];
  try {
    const detailData = await fetchPublicJson(`https://games.roblox.com/v1/games?universeIds=${universeIds.map(encodeURIComponent).join(',')}`);
    details = Array.isArray(detailData && detailData.data) ? detailData.data : [];
  } catch (error) {
    return placeIds.map((placeId) => ({ ok: false, placeId, error: error.message || 'ดึงรายละเอียดเกมไม่สำเร็จ', code: error.code || 'GAME_DETAILS_ERROR' }));
  }
  const detailByUniverse = new Map(details.map((item) => [String(item.id), item]));

  let thumbnailByUniverse = new Map();
  try {
    const thumbnails = await fetchPublicJson(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeIds.map(encodeURIComponent).join(',')}&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false`);
    const items = Array.isArray(thumbnails && thumbnails.data) ? thumbnails.data : [];
    thumbnailByUniverse = new Map(items.map((item) => [String(item.targetId), item.imageUrl || '']));
  } catch (error) {
    // Icons are optional; a thumbnail outage must not hide otherwise valid game telemetry.
    console.warn('Roblox thumbnail lookup failed:', error && error.message);
  }

  const gamesByPlace = new Map();
  valid.forEach(({ placeId, universeId }) => {
    const detail = detailByUniverse.get(String(universeId));
    if (!detail) {
      gamesByPlace.set(placeId, { ok: false, placeId, error: 'ไม่พบรายละเอียดเกมสำหรับ Universe ID นี้', code: 'GAME_DETAILS_NOT_FOUND' });
      return;
    }
    const game = normalizeGame(placeId, universeId, detail, thumbnailByUniverse.get(String(universeId)) || '');
    gamesByPlace.set(placeId, { ok: true, ...game });
  });
  placeIds.forEach((placeId) => {
    if (!gamesByPlace.has(placeId)) {
      const error = resolveErrors.get(placeId);
      gamesByPlace.set(placeId, { ok: false, placeId, error: error?.message || 'ไม่พบข้อมูลเกมจาก Roblox', code: error?.code || 'GAME_NOT_FOUND' });
    }
  });
  const result = placeIds.map((id) => gamesByPlace.get(id));
  const successful = result.filter((item) => item.ok).map(({ ok, ...game }) => game);
  const storage = await persistSnapshots(env, successful);
  return result.map((item) => item.ok ? { ...item, storage } : item);
}
async function persistSnapshots(env, games) {
  if (!env.DB || !games.length) return 'local';
  try {
    const now = Date.now();
    const statements = [];
    for (const game of games) {
      const playable = typeof game.isPlayable === 'boolean' ? (game.isPlayable ? 1 : 0) : null;
      statements.push(env.DB.prepare(`INSERT INTO monitored_games (place_id, universe_id, name, creator_name, creator_id, is_playable, last_seen, last_playing, max_players, visits)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(place_id) DO UPDATE SET universe_id=excluded.universe_id, name=excluded.name, creator_name=excluded.creator_name,
        creator_id=excluded.creator_id, is_playable=excluded.is_playable, last_seen=excluded.last_seen, last_playing=excluded.last_playing,
        max_players=excluded.max_players, visits=excluded.visits`)
        .bind(game.placeId, game.universeId == null ? null : String(game.universeId), game.name, game.creatorName, game.creatorId == null ? null : String(game.creatorId), playable, now, game.playing, game.maxPlayers, game.visits));
      statements.push(env.DB.prepare(`INSERT INTO game_snapshots (place_id, universe_id, game_name, sampled_at, playing, max_players, visits, is_playable)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(game.placeId, game.universeId == null ? null : String(game.universeId), game.name, game.checkedAt || now, game.playing, game.maxPlayers, game.visits, playable));
    }
    await env.DB.batch(statements);
    return 'd1';
  } catch (error) {
    console.error('Could not persist Roblox game snapshots:', error && error.message);
    return 'degraded';
  }
}
async function enforceRateLimit(request, env) {
  if (!env.DB) return { allowed: true, limit: DEFAULT_RATE_LIMIT };
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return { allowed: true, limit: DEFAULT_RATE_LIMIT };
  const windowStart = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const keyMaterial = `${ip}:${windowStart}:${env.RATE_LIMIT_SALT || 'configure-a-secret-in-production'}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyMaterial));
  const ipHash = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  try {
    const result = await env.DB.prepare(`INSERT INTO request_limits (ip_hash, window_start, hits) VALUES (?, ?, 1)
      ON CONFLICT(ip_hash, window_start) DO UPDATE SET hits=hits+1 RETURNING hits`).bind(ipHash, windowStart).first();
    const limit = Number(env.API_REQUEST_LIMIT) > 0 ? Math.min(Number(env.API_REQUEST_LIMIT), 500) : DEFAULT_RATE_LIMIT;
    return { allowed: Number(result && result.hits) <= limit, limit, retryAfter: Math.ceil((windowStart + WINDOW_MS - Date.now()) / 1000) };
  } catch (error) {
    console.warn('Rate limiter unavailable, allowing request:', error && error.message);
    return { allowed: true, limit: DEFAULT_RATE_LIMIT, degraded: true };
  }
}
async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return withCors(request, new Response(null, { status: 204, headers: { 'Access-Control-Max-Age': '86400' } }), env);
  if (request.method !== 'GET') return withCors(request, json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }, 405, { Allow: 'GET, OPTIONS' }), env);

  if (url.pathname === '/api/health') {
    let d1 = false;
    if (env.DB) {
      try { await env.DB.prepare('SELECT 1 AS healthy FROM game_snapshots LIMIT 1').first(); d1 = true; } catch (_) { d1 = false; }
    }
    return withCors(request, json({ ok: true, service: 'roblox-live-console', version: env.APP_VERSION || APP_VERSION, checkedAt: Date.now(), maxTrackedGames: MAX_TRACKED, historyRetentionDays: MAX_HISTORY_DAYS, storage: { d1, fallback: 'browser-localStorage' }, publicDataOnly: true }), env);
  }

  const rate = await enforceRateLimit(request, env);
  if (!rate.allowed) return withCors(request, json({ error: 'เรียก API ถี่เกินไป กรุณารอก่อนลองใหม่', code: 'RATE_LIMITED', retryAfter: rate.retryAfter }, 429, { 'Retry-After': String(rate.retryAfter || 60) }), env);

  if (url.pathname === '/api/history') {
    const placeId = positivePlaceId(url.searchParams.get('placeId'));
    if (!placeId) return withCors(request, json({ error: 'กรุณาระบุ Place ID ที่ถูกต้อง', code: 'INVALID_PLACE_ID' }, 400), env);
    const range = ['1h', '6h', '24h', '7d', '30d'].includes(url.searchParams.get('range')) ? url.searchParams.get('range') : '24h';
    if (!env.DB) return withCors(request, json({ placeId, range, source: 'local', samples: [], retentionDays: 0 }), env);
    const now = Date.now();
    const rangeMs = { '1h': 3600000, '6h': 21600000, '24h': 86400000, '7d': 604800000, '30d': 2592000000 }[range];
    const bucketMs = { '1h': 60_000, '6h': 60_000, '24h': 300_000, '7d': 900_000, '30d': 1_800_000 }[range];
    try {
      const rows = await env.DB.prepare(`SELECT CAST(sampled_at / ? AS INTEGER) * ? AS ts, CAST(AVG(playing) AS INTEGER) AS playing,
        MAX(max_players) AS maxPlayers, MAX(visits) AS visits, COUNT(*) AS sampleCount
        FROM game_snapshots WHERE place_id = ? AND sampled_at >= ?
        GROUP BY CAST(sampled_at / ? AS INTEGER) ORDER BY ts ASC LIMIT 2000`)
        .bind(bucketMs, bucketMs, placeId, now - rangeMs, bucketMs).all();
      const samples = (rows.results || []).map((row) => ({ ts: Number(row.ts), playing: safeNumber(row.playing), maxPlayers: safeNumber(row.maxPlayers), visits: safeNumber(row.visits), sampleCount: Number(row.sampleCount) || 1 }));
      return withCors(request, json({ placeId, range, source: 'd1', samples, retentionDays: MAX_HISTORY_DAYS, checkedAt: now }), env);
    } catch (error) {
      console.error('History query failed:', error && error.message);
      return withCors(request, json({ placeId, range, source: 'local', samples: [], warning: 'D1 history unavailable', retentionDays: 0 }), env);
    }
  }

  if (url.pathname === '/api/game' || url.pathname === '/api/games') {
    let placeIds;
    if (url.pathname === '/api/game') {
      const id = positivePlaceId(url.searchParams.get('placeId'));
      if (!id) return withCors(request, json({ error: 'กรุณาระบุ Place ID ที่ถูกต้อง', code: 'INVALID_PLACE_ID' }, 400), env);
      placeIds = [id];
    } else {
      const raw = url.searchParams.get('placeIds') || '';
      placeIds = [...new Set(raw.split(',').map(positivePlaceId).filter(Boolean))];
      if (!placeIds.length) return withCors(request, json({ error: 'กรุณาระบุ placeIds อย่างน้อยหนึ่งรายการ', code: 'INVALID_PLACE_IDS' }, 400), env);
      const maxTracked = Number(env.MAX_TRACKED_GAMES) > 0 ? Math.min(Number(env.MAX_TRACKED_GAMES), MAX_TRACKED) : MAX_TRACKED;
      if (placeIds.length > maxTracked) return withCors(request, json({ error: `ติดตามได้สูงสุด ${maxTracked} เกมต่อคำขอ`, code: 'TOO_MANY_PLACE_IDS' }, 400), env);
    }
    try {
      const games = await getGames(placeIds, env);
      if (url.pathname === '/api/game') {
        const item = games[0];
        if (!item || item.ok === false) return withCors(request, json({ error: item?.error || 'ไม่พบข้อมูลเกม', code: item?.code || 'GAME_NOT_FOUND' }, item?.code === 'ROBLOX_RATE_LIMITED' ? 429 : item?.code?.includes('NOT_FOUND') ? 404 : 502), env);
        const { ok, storage, ...game } = item;
        return withCors(request, json({ ...game, storage }), env);
      }
      return withCors(request, json({ games, storage: games.some((game) => game.storage === 'd1') ? 'd1' : env.DB ? 'degraded' : 'local', checkedAt: Date.now() }), env);
    } catch (error) {
      const status = Number(error && error.status) || 502;
      return withCors(request, json({ error: error.message || 'ตรวจสอบ Roblox API ไม่สำเร็จ', code: error.code || 'INTERNAL_API_ERROR' }, status), env);
    }
  }
  return withCors(request, json({ error: 'API route not found', code: 'NOT_FOUND' }, 404), env);
}

function addSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, ctx);
    if (env.ASSETS) return addSecurityHeaders(await env.ASSETS.fetch(request));
    return json({ error: 'Static assets binding is not configured', code: 'ASSETS_NOT_CONFIGURED' }, 500);
  },
  async scheduled(controller, env, ctx) {
    if (!env.DB) return;
    const cutoff = Date.now() - MAX_HISTORY_DAYS * 24 * 60 * 60 * 1000;
    const rateCutoff = Date.now() - 60 * 60 * 1000;
    ctx.waitUntil(env.DB.batch([
      env.DB.prepare('DELETE FROM game_snapshots WHERE sampled_at < ?').bind(cutoff),
      env.DB.prepare('DELETE FROM request_limits WHERE window_start < ?').bind(rateCutoff)
    ]).catch((error) => console.error('Scheduled cleanup failed:', error && error.message)));
  }
};
