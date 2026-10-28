const APP_VERSION = '2.1.0';
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
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
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
async function enforceRateLimit(request, env, limitOverride = null, bucket = 'api') {
  if (!env.DB) return { allowed: true, limit: DEFAULT_RATE_LIMIT };
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return { allowed: true, limit: DEFAULT_RATE_LIMIT };
  const windowStart = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const keyMaterial = `${bucket}:${ip}:${windowStart}:${env.RATE_LIMIT_SALT || 'configure-a-secret-in-production'}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyMaterial));
  const ipHash = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  try {
    const result = await env.DB.prepare(`INSERT INTO request_limits (ip_hash, window_start, hits) VALUES (?, ?, 1)
      ON CONFLICT(ip_hash, window_start) DO UPDATE SET hits=hits+1 RETURNING hits`).bind(ipHash, windowStart).first();
    const configuredLimit = Number(limitOverride ?? env.API_REQUEST_LIMIT);
    const limit = configuredLimit > 0 ? Math.min(configuredLimit, 1000) : DEFAULT_RATE_LIMIT;
    return { allowed: Number(result && result.hits) <= limit, limit, retryAfter: Math.ceil((windowStart + WINDOW_MS - Date.now()) / 1000) };
  } catch (error) {
    console.warn('Rate limiter unavailable, allowing request:', error && error.message);
    return { allowed: true, limit: DEFAULT_RATE_LIMIT, degraded: true };
  }
}
const MAX_TELEMETRY_EVENTS = 50;
const MAX_TELEMETRY_BODY_BYTES = 64 * 1024;
const MAX_TELEMETRY_EVENT_AGE_MS = MAX_HISTORY_DAYS * 24 * 60 * 60 * 1000;

async function constantTimeSecretMatch(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string' || !candidate || !expected) return false;
  const encoder = new TextEncoder();
  const [candidateHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(candidate)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected))
  ]);
  const a = new Uint8Array(candidateHash);
  const b = new Uint8Array(expectedHash);
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function authorizeTelemetry(request, env) {
  if (typeof env.ROBLOX_INGEST_TOKEN !== 'string' || env.ROBLOX_INGEST_TOKEN.length < 32) {
    return { ok: false, status: 503, error: 'ยังไม่ได้ตั้ง ROBLOX_INGEST_TOKEN หรือ token สั้นเกินไป (ต้องมีอย่างน้อย 32 ตัวอักษร)', code: 'INGEST_NOT_CONFIGURED' };
  }
  const authorization = request.headers.get('Authorization') || '';
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  const supplied = bearer ? bearer[1].trim() : '';
  if (!(await constantTimeSecretMatch(supplied, env.ROBLOX_INGEST_TOKEN))) {
    return { ok: false, status: 401, error: 'ไม่มีสิทธิ์เรียก API นี้ หรือ token ไม่ถูกต้อง', code: 'UNAUTHORIZED' };
  }
  return { ok: true };
}

function normalizeEventTimestamp(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return now;
  let timestamp;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    timestamp = Number(value);
  } else if (typeof value === 'string') {
    timestamp = Date.parse(value);
  } else {
    return null;
  }
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  // Accept Unix seconds as well as Unix milliseconds.
  if (timestamp < 100_000_000_000) timestamp *= 1000;
  if (!Number.isSafeInteger(Math.trunc(timestamp))) return null;
  timestamp = Math.trunc(timestamp);
  if (timestamp < now - MAX_TELEMETRY_EVENT_AGE_MS || timestamp > now + 5 * 60 * 1000) return null;
  return timestamp;
}

function normalizeTelemetryEvent(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'event แต่ละรายการต้องเป็น object', code: 'INVALID_EVENT' };
  const eventId = String(raw.eventId ?? raw.id ?? '').trim();
  if (!/^[A-Za-z0-9._:{}-]{8,128}$/.test(eventId)) return { error: 'eventId ต้องมีความยาว 8–128 ตัวอักษร และใช้ตัวอักษร/ตัวเลข/.-_:{} เท่านั้น', code: 'INVALID_EVENT_ID' };

  const requestedEventType = String(raw.eventType ?? raw.event ?? '').trim().toLowerCase();
  const eventAliases = { join: 'join', player_join: 'join', playerjoined: 'join', leave: 'leave', player_leave: 'leave', playerremoving: 'leave' };
  const eventType = eventAliases[requestedEventType];
  if (!eventType) return { error: 'eventType ต้องเป็น join หรือ leave', code: 'INVALID_EVENT_TYPE' };

  const placeId = positivePlaceId(raw.placeId);
  if (!placeId) return { error: 'placeId ไม่ถูกต้อง', code: 'INVALID_PLACE_ID' };
  const userId = positivePlaceId(raw.userId ?? raw.playerUserId);
  if (!userId) return { error: 'userId ไม่ถูกต้อง', code: 'INVALID_USER_ID' };
  const universeIdRaw = raw.universeId ?? raw.gameId;
  const universeId = universeIdRaw == null || universeIdRaw === '' ? null : positivePlaceId(universeIdRaw);
  if (universeIdRaw != null && universeIdRaw !== '' && !universeId) return { error: 'universeId ไม่ถูกต้อง', code: 'INVALID_UNIVERSE_ID' };

  const jobId = String(raw.jobId ?? raw.serverJobId ?? '').trim();
  if (!jobId || jobId.length > 128 || /[\r\n\u0000-\u001f]/.test(jobId)) return { error: 'jobId ต้องระบุและมีความยาวไม่เกิน 128 ตัวอักษร', code: 'INVALID_JOB_ID' };
  const rawUsername = String(raw.username ?? raw.playerName ?? '').trim();
  if (rawUsername.length > 50 || /[\u0000-\u001f\u007f]/.test(rawUsername)) return { error: 'username ยาวเกินไปหรือมีอักขระควบคุม', code: 'INVALID_USERNAME' };
  const occurredAt = normalizeEventTimestamp(raw.occurredAt ?? raw.timestamp ?? raw.ts, now);
  if (occurredAt === null) return { error: 'occurredAt ไม่ถูกต้อง หรืออยู่นอกช่วงเก็บข้อมูล 30 วัน', code: 'INVALID_TIMESTAMP' };

  return {
    eventId,
    eventType,
    placeId,
    universeId,
    jobId,
    userId,
    username: rawUsername || 'Unknown',
    occurredAt
  };
}

async function handlePlayerEventIngest(request, env) {
  const authorization = await authorizeTelemetry(request, env);
  if (!authorization.ok) return json({ error: authorization.error, code: authorization.code }, authorization.status);

  if (!env.DB) return json({ error: 'ยังไม่ได้ผูก D1 database จึงไม่สามารถบันทึกเหตุการณ์ผู้เล่นได้', code: 'TELEMETRY_STORAGE_UNAVAILABLE' }, 503);
  const rateLimit = await enforceRateLimit(request, env, env.TELEMETRY_REQUEST_LIMIT || 300, 'telemetry');
  if (!rateLimit.allowed) return json({ error: 'ส่ง telemetry ถี่เกินไป กรุณาลดความถี่หรือรวม event เป็น batch', code: 'RATE_LIMITED', retryAfter: rateLimit.retryAfter }, 429, { 'Retry-After': String(rateLimit.retryAfter || 60) });

  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_TELEMETRY_BODY_BYTES) {
    return json({ error: `request body ต้องไม่เกิน ${MAX_TELEMETRY_BODY_BYTES} bytes`, code: 'PAYLOAD_TOO_LARGE' }, 413);
  }
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().includes('application/json')) return json({ error: 'Content-Type ต้องเป็น application/json', code: 'UNSUPPORTED_MEDIA_TYPE' }, 415);

  let textBody;
  try { textBody = await request.text(); }
  catch (_) { return json({ error: 'อ่าน request body ไม่สำเร็จ', code: 'INVALID_BODY' }, 400); }
  if (new TextEncoder().encode(textBody).byteLength > MAX_TELEMETRY_BODY_BYTES) return json({ error: `request body ต้องไม่เกิน ${MAX_TELEMETRY_BODY_BYTES} bytes`, code: 'PAYLOAD_TOO_LARGE' }, 413);
  let payload;
  try { payload = JSON.parse(textBody); }
  catch (_) { return json({ error: 'JSON ไม่ถูกต้อง', code: 'INVALID_JSON' }, 400); }

  const events = Array.isArray(payload?.events) ? payload.events : [payload];
  if (!events.length || events.length > MAX_TELEMETRY_EVENTS) {
    return json({ error: `ส่งได้ 1–${MAX_TELEMETRY_EVENTS} events ต่อคำขอ`, code: 'INVALID_EVENT_COUNT' }, 400);
  }
  const now = Date.now();
  const normalized = [];
  const seenIds = new Set();
  for (const raw of events) {
    const event = normalizeTelemetryEvent(raw, now);
    if (event.error) return json({ error: event.error, code: event.code }, 400);
    if (seenIds.has(event.eventId)) return json({ error: 'eventId ซ้ำกันภายใน batch เดียวกัน', code: 'DUPLICATE_EVENT_ID_IN_BATCH' }, 400);
    seenIds.add(event.eventId);
    normalized.push(event);
  }

  // Keep the event log and session projection in one D1 transaction. The batch_id
  // guard prevents a retried event from mutating an already newer session state.
  const batchId = crypto.randomUUID();
  const statements = [];
  for (const event of normalized) {
    statements.push(env.DB.prepare(`INSERT INTO player_events
      (event_id, batch_id, event_type, place_id, universe_id, job_id, user_id, username, occurred_at, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING`)
      .bind(event.eventId, batchId, event.eventType, event.placeId, event.universeId, event.jobId, event.userId, event.username, event.occurredAt, now));
  }
  for (const event of normalized) {
    if (event.eventType === 'join') {
      statements.push(env.DB.prepare(`INSERT INTO player_sessions
        (place_id, job_id, user_id, username, joined_at, last_event_at, left_at, is_active)
        SELECT ?, ?, ?, ?, ?, ?, NULL, 1
        WHERE EXISTS (SELECT 1 FROM player_events WHERE event_id = ? AND batch_id = ?)
        ON CONFLICT(place_id, job_id, user_id) DO UPDATE SET
          username = excluded.username, joined_at = excluded.joined_at,
          last_event_at = excluded.last_event_at, left_at = NULL, is_active = 1
        WHERE excluded.last_event_at >= player_sessions.last_event_at`)
        .bind(event.placeId, event.jobId, event.userId, event.username, event.occurredAt, event.occurredAt, event.eventId, batchId));
    } else {
      statements.push(env.DB.prepare(`INSERT INTO player_sessions
        (place_id, job_id, user_id, username, joined_at, last_event_at, left_at, is_active)
        SELECT ?, ?, ?, ?, ?, ?, ?, 0
        WHERE EXISTS (SELECT 1 FROM player_events WHERE event_id = ? AND batch_id = ?)
        ON CONFLICT(place_id, job_id, user_id) DO UPDATE SET
          username = excluded.username, last_event_at = excluded.last_event_at,
          left_at = excluded.left_at, is_active = 0
        WHERE excluded.last_event_at >= player_sessions.last_event_at`)
        .bind(event.placeId, event.jobId, event.userId, event.username, event.occurredAt, event.occurredAt, event.occurredAt, event.eventId, batchId));
    }
  }

  try {
    const results = await env.DB.batch(statements);
    const inserted = (results || []).slice(0, normalized.length).filter((result) => Number(result?.meta?.changes) > 0).length;
    return json({ ok: true, accepted: inserted, duplicates: normalized.length - inserted, received: normalized.length, batchId, receivedAt: now }, 200);
  } catch (error) {
    console.error('Player telemetry write failed:', error && error.message);
    return json({ error: 'บันทึก player telemetry ไม่สำเร็จ ตรวจสอบ migration 0002 และ D1 logs', code: 'TELEMETRY_WRITE_FAILED' }, 503);
  }
}

async function handlePlayerTelemetryRead(request, env, url) {
  const authorization = await authorizeTelemetry(request, env);
  if (!authorization.ok) return json({ error: authorization.error, code: authorization.code }, authorization.status);
  if (!env.DB) return json({ error: 'ยังไม่ได้ผูก D1 database', code: 'TELEMETRY_STORAGE_UNAVAILABLE' }, 503);
  const rateLimit = await enforceRateLimit(request, env, env.TELEMETRY_REQUEST_LIMIT || 300, 'telemetry');
  if (!rateLimit.allowed) return json({ error: 'เรียก telemetry API ถี่เกินไป', code: 'RATE_LIMITED', retryAfter: rateLimit.retryAfter }, 429, { 'Retry-After': String(rateLimit.retryAfter || 60) });

  const placeId = positivePlaceId(url.searchParams.get('placeId'));
  if (!placeId) return json({ error: 'กรุณาระบุ placeId ที่ถูกต้อง', code: 'INVALID_PLACE_ID' }, 400);
  const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '100', 10);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 200)) : 100;
  try {
    if (url.pathname === '/api/roblox/players') {
      const [countRow, rows] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) AS activeCount FROM player_sessions WHERE place_id = ? AND is_active = 1').bind(placeId).first(),
        env.DB.prepare(`SELECT place_id AS placeId, job_id AS jobId, user_id AS userId, username,
          joined_at AS joinedAt, last_event_at AS lastEventAt
          FROM player_sessions WHERE place_id = ? AND is_active = 1
          ORDER BY joined_at DESC LIMIT ?`).bind(placeId, limit).all()
      ]);
      return json({ ok: true, placeId, source: 'd1', activeCount: Number(countRow?.activeCount) || 0, returnedCount: (rows.results || []).length, players: rows.results || [], checkedAt: Date.now() });
    }
    const rows = await env.DB.prepare(`SELECT event_id AS eventId, event_type AS eventType, place_id AS placeId,
      universe_id AS universeId, job_id AS jobId, user_id AS userId, username,
      occurred_at AS occurredAt, received_at AS receivedAt
      FROM player_events WHERE place_id = ? ORDER BY occurred_at DESC LIMIT ?`).bind(placeId, limit).all();
    return json({ ok: true, placeId, source: 'd1', events: rows.results || [], checkedAt: Date.now() });
  } catch (error) {
    console.error('Player telemetry read failed:', error && error.message);
    return json({ error: 'อ่าน player telemetry ไม่สำเร็จ ตรวจสอบว่า apply migration 0002 แล้ว', code: 'TELEMETRY_READ_FAILED' }, 503);
  }
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return withCors(request, new Response(null, { status: 204, headers: { 'Access-Control-Max-Age': '86400' } }), env);

  if (url.pathname === '/api/roblox/player-events' && request.method === 'POST') {
    const response = await handlePlayerEventIngest(request, env);
    return withCors(request, response, env);
  }
  if ((url.pathname === '/api/roblox/player-events' || url.pathname === '/api/roblox/players') && request.method === 'GET') {
    const response = await handlePlayerTelemetryRead(request, env, url);
    return withCors(request, response, env);
  }
  if (request.method !== 'GET') return withCors(request, json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }, 405, { Allow: 'GET, POST, OPTIONS' }), env);

  if (url.pathname === '/api/health') {
    let d1 = false;
    let telemetrySchema = false;
    if (env.DB) {
      try { await env.DB.prepare('SELECT 1 AS healthy FROM game_snapshots LIMIT 1').first(); d1 = true; } catch (_) { d1 = false; }
      try { await env.DB.prepare('SELECT 1 AS healthy FROM player_events LIMIT 1').first(); telemetrySchema = true; } catch (_) { telemetrySchema = false; }
    }
    return withCors(request, json({ ok: true, service: 'roblox-live-console', version: env.APP_VERSION || APP_VERSION, checkedAt: Date.now(), maxTrackedGames: Number(env.MAX_TRACKED_GAMES) > 0 ? Math.min(Number(env.MAX_TRACKED_GAMES), MAX_TRACKED) : MAX_TRACKED, historyRetentionDays: MAX_HISTORY_DAYS, storage: { d1, fallback: 'browser-localStorage' }, telemetry: { configured: typeof env.ROBLOX_INGEST_TOKEN === 'string' && env.ROBLOX_INGEST_TOKEN.length >= 32, schemaReady: telemetrySchema, maxEventsPerRequest: MAX_TELEMETRY_EVENTS, retentionDays: MAX_HISTORY_DAYS, endpoint: '/api/roblox/player-events' }, publicGameMetadataOnly: true }), env);
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
      const rawIds = raw.split(',').map((item) => item.trim()).filter(Boolean);
      if (!rawIds.length || rawIds.some((item) => !positivePlaceId(item))) return withCors(request, json({ error: 'กรุณาระบุ placeIds เป็นตัวเลขคั่นด้วย comma เท่านั้น', code: 'INVALID_PLACE_IDS' }, 400), env);
      placeIds = [...new Set(rawIds.map(positivePlaceId))];
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
    // Keep the original game-history cleanup independent from telemetry migrations.
    const baseCleanup = env.DB.batch([
      env.DB.prepare('DELETE FROM game_snapshots WHERE sampled_at < ?').bind(cutoff),
      env.DB.prepare('DELETE FROM request_limits WHERE window_start < ?').bind(rateCutoff)
    ]).catch((error) => console.error('Scheduled game/rate-limit cleanup failed:', error && error.message));
    // A missing leave event must not leave a player marked active forever.
    // Event history and inactive projections follow the same 30-day retention window.
    const telemetryCleanup = env.DB.batch([
      env.DB.prepare('DELETE FROM player_events WHERE occurred_at < ?').bind(cutoff),
      env.DB.prepare('UPDATE player_sessions SET is_active = 0, left_at = last_event_at WHERE is_active = 1 AND last_event_at < ?').bind(cutoff),
      env.DB.prepare('DELETE FROM player_sessions WHERE is_active = 0 AND last_event_at < ?').bind(cutoff)
    ]).catch((error) => console.warn('Scheduled telemetry cleanup skipped (apply migration 0002):', error && error.message));
    ctx.waitUntil(Promise.all([baseCleanup, telemetryCleanup]));
  }
};
