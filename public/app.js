'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const STORAGE = {
    tracked: 'robloxMonitorTrackedGames',
    active: 'robloxMonitorPlaceId',
    historyPrefix: 'robloxMonitorHistory:',
    events: 'robloxMonitorEvents',
    threshold: 'robloxMonitorPlayerThreshold',
    notifications: 'robloxMonitorNotifications',
    alertState: 'robloxMonitorAlertState',
    layout: 'robloxMonitorLayout',
    range: 'robloxMonitorRange',
    sort: 'robloxMonitorSort',
    hidden: 'robloxMonitorHiddenSeries',
    metric: 'robloxMonitorMetric'
  };
  const MAX_TRACKED_GAMES = 10;
  const MAX_LOCAL_SAMPLES = 1500;
  const MAX_EVENTS = 40;
  const DEFAULT_REFRESH_SECONDS = 60;
  const DEFAULT_PLAYER_THRESHOLD = 100;
  const RANGE_MS = { '1h': 36e5, '6h': 216e5, '24h': 864e5, '7d': 6048e5, '30d': 2592e6 };
  const COLORS = ['#2457d6', '#d9730d', '#0f9d76', '#b5338a', '#cf3b3b', '#0b8ea6', '#6d4bd1', '#6a9a1f', '#d1457a', '#566579'];
  const VIEWS = ['overview', 'compare', 'game', 'events', 'policy'];

  // ---------- helpers ----------
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    kids.flat().forEach((kid) => { if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid))); });
    return el;
  }
  function safeRead(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (_) { return fallback; }
  }
  function readAlertState() {
    const value = safeRead(STORAGE.alertState, {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  function safeWrite(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
  }
  function safeRemove(key) { try { localStorage.removeItem(key); } catch (_) { /* storage can be disabled */ } }
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const fmt = (v) => { const n = num(v); return n === null ? '—' : new Intl.NumberFormat('th-TH', { maximumFractionDigits: 0 }).format(n); };
  const fmtCompact = (v) => { const n = num(v); return n === null ? '—' : new Intl.NumberFormat('th-TH', { notation: n >= 100000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n); };
  const fmtSigned = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n))}`;
  const fmtPct = (n) => n === null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`;
  function fmtClock(value, withSeconds = true) {
    const d = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(d.getTime())) return '—';
    return new Intl.DateTimeFormat('th-TH', withSeconds ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
  }
  function fmtAxis(ts, range) {
    const d = new Date(ts);
    return new Intl.DateTimeFormat('th-TH', RANGE_MS[range] <= 864e5 ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' }).format(d);
  }
  function validPlaceId(value) {
    const id = String(value ?? '').trim();
    return /^\d{1,20}$/.test(id) && BigInt(id) > 0n ? id : null;
  }
  function parsePlaceId(raw) {
    const text = String(raw || '').trim();
    const match = text.match(/roblox\.com\/(?:[a-z-]+\/)?games\/(\d+)/i) || text.match(/^(\d{1,20})$/);
    return match ? validPlaceId(match[1]) : null;
  }
  const initial = (name) => (String(name || 'R').trim().charAt(0) || 'R').toUpperCase();
  const colorFor = (placeId) => { const i = trackedGames.findIndex((g) => g.placeId === placeId); return COLORS[(i < 0 ? 0 : i) % COLORS.length]; };

  // ---------- state ----------
  let trackedGames = [];
  const gameState = new Map(); // placeId -> { game, status, error, lastChecked }
  let seriesByGame = {};
  let seriesSource = 'local';
  let currentPlaceId = null;
  let view = 'overview';
  let range = RANGE_MS[safeRead(STORAGE.range, '24h')] ? safeRead(STORAGE.range, '24h') : '24h';
  let sortBy = ['players', 'change', 'name'].includes(safeRead(STORAGE.sort, 'players')) ? safeRead(STORAGE.sort, 'players') : 'players';
  let layout = safeRead(STORAGE.layout, window.matchMedia('(max-width: 650px)').matches ? 'wall' : 'table') === 'wall' ? 'wall' : 'table';
  let metric = safeRead(STORAGE.metric, 'players') === 'index' ? 'index' : 'players';
  const storedHidden = safeRead(STORAGE.hidden, []);
  let hiddenSeries = new Set(Array.isArray(storedHidden) ? storedHidden : []);
  let historyRequest = 0;
  let apiHealth = { checked: false, online: false, d1: false };
  let activeRequest = false;
  let refreshQueued = false;
  let refreshTimer = null;
  let nextRefreshAt = null;
  let refreshSeconds = DEFAULT_REFRESH_SECONDS;
  let playerThreshold = DEFAULT_PLAYER_THRESHOLD;
  let notificationsEnabled = false;
  let lastSuccessfulAt = null;
  let bannerTimer = null;
  const justAdded = new Set();

  const els = {
    form: $('#gameForm'), placeId: $('#placeId'), checkBtn: $('#checkBtn'), refreshNow: $('#refreshNow'), refreshInterval: $('#refreshInterval'),
    countdown: $('#countdown'), message: $('#message'), overviewBody: $('#overviewBody'), kpis: $('#kpis'), compareBody: $('#compareBody'), gameBody: $('#gameBody'),
    rangeA: $('#rangeSelector'), rangeB: $('#rangeSelector2'), sort: $('#sortSelector'), tracking: $('#trackingStatus'), navCount: $('#navGameCount'), navEvents: $('#navEventCount'),
    systemDot: $('#systemDot'), systemText: $('#systemText'), storageMode: $('#storageMode'), appVersion: $('#appVersion'), lastCheck: $('#lastSuccessfulCheck'),
    threshold: $('#playerThreshold'), notifToggle: $('#notificationsToggle'), alertLog: $('#alertLog'), clearEvents: $('#clearEvents')
  };

  // ---------- messages / status ----------
  function setMessage(text, type = '', source = '') {
    const box = els.message; if (!box) return;
    clearTimeout(bannerTimer);
    box.dataset.source = source;
    if (!text) { box.hidden = true; return; }
    $('.banner-text', box).textContent = text;
    box.className = `banner ${type}`.trim(); box.hidden = false;
    if (type === 'success' || type === '') bannerTimer = setTimeout(() => { box.hidden = true; }, 6000);
  }
  function setSystemStatus(label, type = 'ok') {
    els.systemDot.className = `dot${type === 'error' ? ' error' : type === 'warning' ? ' warning' : ''}`;
    els.systemText.textContent = label;
  }
  function setLoading(loading) {
    els.checkBtn.disabled = loading;
    $('.btn-label', els.checkBtn).textContent = loading ? 'กำลังตรวจสอบ…' : 'เพิ่มเกม';
    els.refreshNow.disabled = loading; els.refreshNow.classList.toggle('spinning', loading);
  }

  // ---------- persistence ----------
  const historyKey = (id) => `${STORAGE.historyPrefix}${id}`;
  function readLocalHistory(placeId) {
    const stored = safeRead(historyKey(placeId), []);
    if (!Array.isArray(stored)) return [];
    const cutoff = Date.now() - RANGE_MS['30d'];
    return stored.filter((p) => p && Number.isFinite(Number(p.ts)) && Number(p.ts) >= cutoff && num(p.playing) !== null)
      .map((p) => ({ ts: Number(p.ts), playing: Number(p.playing), maxPlayers: num(p.maxPlayers), visits: num(p.visits), sampleCount: p.sampleCount || 1 }))
      .sort((a, b) => a.ts - b.ts).slice(-MAX_LOCAL_SAMPLES);
  }
  function saveLocalSnapshot(game) {
    if (!game || num(game.playing) === null) return;
    const history = readLocalHistory(game.placeId);
    const ts = num(game.checkedAt) || Date.now();
    const last = history[history.length - 1];
    if (last && Math.abs(last.ts - ts) < 1000) return;
    history.push({ ts, playing: Number(game.playing), maxPlayers: num(game.maxPlayers), visits: num(game.visits), sampleCount: 1 });
    safeWrite(historyKey(game.placeId), history.slice(-MAX_LOCAL_SAMPLES));
  }
  function persistTracked() {
    safeWrite(STORAGE.tracked, trackedGames);
    if (currentPlaceId) safeWrite(STORAGE.active, currentPlaceId); else safeRemove(STORAGE.active);
  }
  function loadTracked() {
    const stored = safeRead(STORAGE.tracked, []);
    trackedGames = (Array.isArray(stored) ? stored : []).map((i) => ({ placeId: validPlaceId(i && i.placeId), name: String((i && i.name) || '') }))
      .filter((i) => i.placeId).slice(0, MAX_TRACKED_GAMES);
    // Migrate the single-game setting used by older versions.
    if (!trackedGames.length) {
      const legacy = validPlaceId(safeRead(STORAGE.active, null));
      if (legacy) { trackedGames = [{ placeId: legacy, name: '' }]; safeWrite(STORAGE.tracked, trackedGames); }
    }
    trackedGames.forEach(item => {
      const last = readLocalHistory(item.placeId).at(-1);
      const game = last ? normalizeGame({ ...last, checkedAt: last.ts, name: item.name }, item.placeId) : null;
      gameState.set(item.placeId, { game, status: game ? 'stale' : 'idle', error: null, lastChecked: last?.ts, name: item.name });
    });
    const savedActive = validPlaceId(safeRead(STORAGE.active, null));
    currentPlaceId = savedActive && trackedGames.some((i) => i.placeId === savedActive) ? savedActive : (trackedGames[0] ? trackedGames[0].placeId : null);
  }
  const record = (id) => { if (!gameState.has(id)) gameState.set(id, { game: null, status: 'idle', error: null, lastChecked: null }); return gameState.get(id); };
  const gameName = (id) => { const s = record(id); return (s.game && s.game.name) || s.name || `Place ${id}`; };

  // ---------- API ----------
  async function requestJson(path, timeoutMs = 14000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
      const text = await response.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; } catch (_) {
        const e = new Error(response.ok ? 'API ไม่ได้ส่งข้อมูล JSON กลับมา ตรวจสอบการติดตั้ง Worker' : `เรียก API ไม่สำเร็จ (${response.status})`); e.status = response.status; throw e;
      }
      if (!response.ok) { const e = new Error(body.error || `เรียก API ไม่สำเร็จ (${response.status})`); e.status = response.status; e.code = body.code || ''; throw e; }
      return body;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('การเชื่อมต่อใช้เวลานานเกินกำหนด กรุณาลองอีกครั้ง');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function checkApiHealth() {
    try {
      const health = await requestJson('/api/health', 6000);
      apiHealth = { checked: true, online: true, d1: Boolean(health.storage && health.storage.d1), version: health.version };
      els.appVersion.textContent = health.version || els.appVersion.textContent;
      els.storageMode.textContent = apiHealth.d1 ? 'ประวัติเก็บใน D1 (30 วัน)' : 'ประวัติเก็บในเบราว์เซอร์นี้';
      setSystemStatus(apiHealth.d1 ? 'ระบบพร้อมใช้งาน' : 'ใช้ที่เก็บข้อมูลในเบราว์เซอร์', apiHealth.d1 ? 'ok' : 'warning');
    } catch (_) {
      apiHealth = { checked: true, online: false, d1: false };
      els.storageMode.textContent = 'ติดต่อ API ไม่ได้';
      setSystemStatus('ติดต่อ API ไม่ได้', 'error');
    }
  }
  function normalizeGame(g, requestedId) {
    return {
      placeId: String(g.placeId || requestedId), universeId: g.universeId ?? null, name: g.name || `Place ${requestedId}`, creatorName: g.creatorName || '', creatorId: g.creatorId ?? null,
      isPlayable: typeof g.isPlayable === 'boolean' ? g.isPlayable : null, playing: num(g.playing), maxPlayers: num(g.maxPlayers), visits: num(g.visits),
      iconUrl: typeof g.iconUrl === 'string' && g.iconUrl.startsWith('https://') ? g.iconUrl : '', checkedAt: num(g.checkedAt) || Date.now()
    };
  }
  function markFailure(placeId, message, code) {
    const s = record(placeId);
    const wasHealthy = !s.error;
    s.status = s.game ? 'stale' : 'failed'; s.error = message; s.code = code || '';
    if (wasHealthy) pushEvent('error', 'ดึงข้อมูลไม่สำเร็จ', `${gameName(placeId)}: ${message}`, placeId, false);
  }
  async function refreshTracked({ quiet = true } = {}) {
    if (!trackedGames.length) { scheduleNextRefresh(); return; }
    if (activeRequest) { refreshQueued = true; return; }
    activeRequest = true; clearTimeout(refreshTimer); nextRefreshAt = null; setLoading(true); updateCountdown();
    const ids = trackedGames.map((g) => g.placeId);
    
    try {
      if (!apiHealth.online) await checkApiHealth();
      const payload = await requestJson(`/api/games?placeIds=${encodeURIComponent(ids.join(','))}`, 30000);
      const results = Array.isArray(payload.games) ? payload.games : [];
      const seen = new Set(); let okCount = 0; const failed = [];
      results.forEach((result) => {
        const id = validPlaceId(result && result.placeId);
        if (!id || !ids.includes(id) || !trackedGames.some(g => g.placeId === id)) return;
        seen.add(id);
        if (result.ok === false) { markFailure(id, result.error || 'ไม่พบข้อมูลจาก API', result.code); failed.push(id); return; }
        const game = normalizeGame(result, id);
        if (game.playing === null) { markFailure(id, 'ข้อมูลจาก API ไม่ครบถ้วน'); failed.push(id); return; }
        detectAlerts(game);
        const s = record(id); s.game = game; s.status = 'ok'; s.error = null; s.code = ''; s.lastChecked = game.checkedAt; s.name = game.name;
        const t = trackedGames.find((x) => x.placeId === id); if (t) t.name = game.name;
        saveLocalSnapshot(game); okCount += 1;
      });
      ids.filter((id) => !seen.has(id) && trackedGames.some(g => g.placeId === id)).forEach((id) => { markFailure(id, 'API ไม่ส่งผลลัพธ์ของเกมนี้'); failed.push(id); });
      // A newly added Place ID that Roblox does not know is removed instead of lingering as an error row.
      const rejected = [];
      justAdded.forEach((id) => {
        if (!ids.includes(id)) return;
        justAdded.delete(id);
        const s = record(id);
        if (s.status === 'failed' && /NOT_FOUND/.test(s.code || '')) { rejected.push(id); removeGame(id, true); }
      });
      rejected.forEach((id) => { const i = failed.indexOf(id); if (i >= 0) failed.splice(i, 1); });
      persistTracked();
      if (okCount) {
        const stored = results.find(result => result.ok && result.storage)?.storage;
        if (stored) {
          apiHealth.online = true;
          apiHealth.d1 = stored === 'd1';
          els.storageMode.textContent = apiHealth.d1 ? 'ประวัติเก็บใน D1 (30 วัน)' : 'ประวัติเก็บในเบราว์เซอร์นี้';
        }
        lastSuccessfulAt = Date.now(); els.lastCheck.textContent = `ข้อมูลล่าสุด ${fmtClock(lastSuccessfulAt)}`;
        if (failed.length) { setSystemStatus(`ข้อมูลบางส่วน ${okCount}/${ids.length} เกม`, 'warning'); setMessage(`อัปเดตสำเร็จ ${okCount} จาก ${ids.length} เกม เกมที่ล้มเหลวจะแสดงข้อมูลเดิมพร้อมป้ายข้อมูลเก่า`, 'warning', 'refresh'); }
        else {
          setSystemStatus(apiHealth.d1 ? 'ระบบพร้อมใช้งาน' : 'ใช้ที่เก็บข้อมูลในเบราว์เซอร์', apiHealth.d1 ? 'ok' : 'warning');
          if (quiet && !els.message.hidden && els.message.dataset.source === 'refresh') setMessage('กลับมาอัปเดตข้อมูลได้แล้ว', 'success');
          if (!quiet) setMessage(`อัปเดต ${okCount} เกมสำเร็จ`, 'success');
        }
      } else if (ids.length > rejected.length) {
        setSystemStatus('ดึงข้อมูลเกมไม่ได้', 'error');
        setMessage('ดึงข้อมูลเกมไม่ได้ ตรวจสอบการเชื่อมต่อ Worker หรือสถานะ Roblox แล้วลองอีกครั้ง', 'error', 'refresh');
      }
      if (rejected.length) setMessage(`ไม่พบเกม Place ID ${rejected.join(', ')} หรือเกมไม่เปิดเผยต่อสาธารณะ จึงไม่ได้เพิ่มเข้ารายการ`, 'error');
    } catch (error) {
      setSystemStatus('การเชื่อมต่อผิดพลาด', 'error');
      setMessage(`${error.message || 'เชื่อมต่อ API ไม่สำเร็จ'} ข้อมูลเดิมยังแสดงอยู่และติดป้ายข้อมูลเก่า`, 'error', 'refresh');
      trackedGames.forEach((g) => markFailure(g.placeId, error.message || 'API ไม่พร้อมใช้งาน'));
    }
    renderAll();
    try { await loadSeries(); } catch (_) { /* local fallback is used */ }
    activeRequest = false; setLoading(false);
    renderAll(); scheduleNextRefresh();
    if (refreshQueued) { refreshQueued = false; refreshTracked({ quiet: true }); }
  }
  async function loadSeries() {
    const requestId = ++historyRequest;
    const ids = trackedGames.map((g) => g.placeId);
    if (!ids.length) { seriesByGame = {}; return; }
    const cutoff = Date.now() - RANGE_MS[range];
    let server = {}; let bucketMs = 0;
    if (apiHealth.online) {
      try {
        const res = await requestJson(`/api/histories?placeIds=${encodeURIComponent(ids.join(','))}&range=${encodeURIComponent(range)}`, 12000);
        if (res.source === 'd1' && res.series) { server = res.series; bucketMs = Number(res.bucketMs) || 1; }
      } catch (_) { /* fall back below */ }
    }
    if (requestId !== historyRequest) return;
    const next = {};
    let hasServer = false, hasLocal = false;
    ids.forEach((id) => {
      const fromServer = (Array.isArray(server[id]) ? server[id] : []).map((p) => ({ ts: Number(p.ts), playing: num(p.playing), maxPlayers: num(p.maxPlayers), visits: num(p.visits) }))
        .filter((p) => Number.isFinite(p.ts) && p.playing !== null).sort((a, b) => a.ts - b.ts);
      if (!trackedGames.some(game => game.placeId === id)) return;
      const last = fromServer.at(-1);
      const local = readLocalHistory(id).filter(p => p.ts >= cutoff && (!last || p.ts >= last.ts + bucketMs));
      next[id] = fromServer.concat(local);
      hasServer ||= fromServer.length > 0;
      hasLocal ||= local.length > 0;
    });
    seriesSource = hasServer ? (hasLocal ? 'mixed' : 'd1') : 'local';
    seriesByGame = next;
  }

  // ---------- game list ops ----------
  function addGame(placeId) {
    if (trackedGames.some((g) => g.placeId === placeId)) return 'exists';
    if (trackedGames.length >= MAX_TRACKED_GAMES) return 'full';
    trackedGames.unshift({ placeId, name: '' });
    record(placeId); justAdded.add(placeId);
    if (!currentPlaceId) currentPlaceId = placeId;
    persistTracked();
    return 'added';
  }
  function removeGame(placeId, silent = false) {
    trackedGames = trackedGames.filter((g) => g.placeId !== placeId);
    justAdded.delete(placeId);
    gameState.delete(placeId); delete seriesByGame[placeId]; hiddenSeries.delete(placeId);
    safeWrite(STORAGE.hidden, [...hiddenSeries]);
    safeRemove(historyKey(placeId));
    const alerts = readAlertState(); delete alerts[placeId]; safeWrite(STORAGE.alertState, alerts);
    if (currentPlaceId === placeId) currentPlaceId = trackedGames[0] ? trackedGames[0].placeId : null;
    persistTracked();
    if (view === 'game' && !silent) navigate('overview');
    if (!silent) { setMessage('นำเกมออกจากรายการแล้ว ประวัติที่เก็บบนเซิร์ฟเวอร์จะหมดอายุเองตามรอบ 30 วัน', 'success'); renderAll(); scheduleNextRefresh(); }
  }

  // ---------- derived data ----------
  function seriesStats(id) {
    const pts = (seriesByGame[id] || []).filter((p) => num(p.playing) !== null);
    if (!pts.length) return null;
    const values = pts.map((p) => p.playing);
    const first = values[0], last = values[values.length - 1];
    const delta = last - first;
    return { points: pts, first, last, delta, pct: first > 0 ? delta / first * 100 : (delta === 0 ? 0 : null), peak: Math.max(...values), avg: values.reduce((a, b) => a + b, 0) / values.length };
  }
  const nowPlaying = (id) => { const s = record(id); return s.game ? num(s.game.playing) : null; };
  function sortedGames() {
    const list = trackedGames.slice();
    const val = (id) => nowPlaying(id) ?? -1;
    if (sortBy === 'name') list.sort((a, b) => gameName(a.placeId).localeCompare(gameName(b.placeId), 'th'));
    else if (sortBy === 'change') list.sort((a, b) => ((seriesStats(b.placeId) || { pct: -Infinity }).pct) - ((seriesStats(a.placeId) || { pct: -Infinity }).pct));
    else list.sort((a, b) => val(b.placeId) - val(a.placeId));
    return list;
  }

  // ---------- chart primitives ----------
  function sparkline(points, color, width, height, fill) {
    if (!points || points.length < 2) return h('span', { class: 'spark-empty' }, 'รอข้อมูล');
    const vals = points.map((p) => p.playing); const min = Math.min(...vals), max = Math.max(...vals);
    const pad = 3, span = Math.max(1, max - min);
    const step = (width - pad * 2) / (points.length - 1);
    const xy = points.map((p, i) => [pad + i * step, pad + (height - pad * 2) * (1 - (p.playing - min) / span)]);
    const d = xy.map((c, i) => `${i ? 'L' : 'M'}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(' ');
    const wrap = h('span', { class: 'spark' });
    wrap.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">${fill ? `<path d="${d} L${xy[xy.length - 1][0].toFixed(1)},${height} L${xy[0][0].toFixed(1)},${height} Z" fill="${color}" fill-opacity=".1"/>` : ''}<path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${xy[xy.length - 1][0].toFixed(1)}" cy="${xy[xy.length - 1][1].toFixed(1)}" r="2.4" fill="${color}"/></svg>`;
    return wrap;
  }
  function niceMax(v) {
    if (v <= 0) return 10;
    const exp = Math.pow(10, Math.floor(Math.log10(v))); const f = v / exp;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
  }
  // Draws one or more series as an SVG line chart sized to its container, with a hover read-out.
  function lineChart(host, items, { height = 300, mode = 'players', area = false, label = 'กราฟจำนวนผู้เล่น' } = {}) {
    host.replaceChildren();
    const visible = items.filter((it) => it.points.length >= 2);
    if (!visible.length) {
      host.append(h('div', { class: 'chart-empty' }, h('strong', { text: 'ยังไม่มีข้อมูลเพียงพอสำหรับกราฟ' }), h('span', { text: 'ระบบต้องเก็บข้อมูลอย่างน้อย 2 จุด เปิดหน้านี้ค้างไว้หรือรอรอบเก็บข้อมูลถัดไป' })));
      return;
    }
    const width = Math.max(320, host.clientWidth || 800);
    const m = { top: 14, right: 16, bottom: 28, left: 52 };
    const series = visible.map((it) => {
      let base = null;
      const pts = it.points.map((p) => {
        if (mode === 'index') { if (base === null && p.playing > 0) base = p.playing; return { ts: p.ts, v: base ? p.playing / base * 100 : null, raw: p.playing }; }
        return { ts: p.ts, v: p.playing, raw: p.playing };
      }).filter((p) => p.v !== null);
      return { ...it, pts };
    }).filter((it) => it.pts.length >= 2);
    if (!series.length) { host.append(h('div', { class: 'chart-empty' }, h('strong', { text: 'ยังคำนวณเทียบจุดเริ่มต้นไม่ได้' }), h('span', { text: 'เกมที่เลือกยังไม่มีผู้เล่นในช่วงนี้' }))); return; }
    const allTs = series.flatMap((s) => s.pts.map((p) => p.ts));
    const t0 = Math.min(...allTs), t1 = Math.max(...allTs);
    const allV = series.flatMap((s) => s.pts.map((p) => p.v));
    let y0 = 0, y1 = niceMax(Math.max(...allV) * 1.05);
    if (mode === 'index') { const lo = Math.min(...allV), hi = Math.max(...allV); const pad = Math.max(5, (hi - lo) * .15); y0 = Math.max(0, Math.floor((lo - pad) / 10) * 10); y1 = Math.ceil((hi + pad) / 10) * 10; }
    const iw = width - m.left - m.right, ih = height - m.top - m.bottom;
    const X = (t) => m.left + (t1 === t0 ? 0 : (t - t0) / (t1 - t0)) * iw;
    const Y = (v) => m.top + ih - (v - y0) / Math.max(1e-9, y1 - y0) * ih;
    const yTicks = 4;
    let svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">`;
    for (let i = 0; i <= yTicks; i += 1) {
      const v = y0 + (y1 - y0) * i / yTicks; const y = Y(v);
      svg += `<line x1="${m.left}" x2="${width - m.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" class="grid"/><text x="${m.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="tick">${mode === 'index' ? Math.round(v) + '%' : fmtCompact(Math.round(v))}</text>`;
    }
    const xTicks = width < 520 ? 3 : 5;
    for (let i = 0; i < xTicks; i += 1) {
      const t = t0 + (t1 - t0) * i / (xTicks - 1); const anchor = i === 0 ? 'start' : i === xTicks - 1 ? 'end' : 'middle';
      svg += `<text x="${X(t).toFixed(1)}" y="${height - 8}" text-anchor="${anchor}" class="tick">${fmtAxis(t, range)}</text>`;
    }
    if (mode === 'index') svg += `<line x1="${m.left}" x2="${width - m.right}" y1="${Y(100).toFixed(1)}" y2="${Y(100).toFixed(1)}" class="baseline"/>`;
    series.forEach((s) => {
      const d = s.pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.ts).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ');
      if (area && series.length === 1) svg += `<path d="${d} L${X(s.pts[s.pts.length - 1].ts).toFixed(1)},${Y(y0).toFixed(1)} L${X(s.pts[0].ts).toFixed(1)},${Y(y0).toFixed(1)} Z" fill="${s.color}" fill-opacity=".09"/>`;
      svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      const lp = s.pts[s.pts.length - 1]; svg += `<circle cx="${X(lp.ts).toFixed(1)}" cy="${Y(lp.v).toFixed(1)}" r="3.5" fill="${s.color}" stroke="#fff" stroke-width="1.5"/>`;
    });
    svg += `<line class="cross" x1="0" x2="0" y1="${m.top}" y2="${m.top + ih}" style="display:none"/><g class="hover-dots"></g></svg>`;
    host.innerHTML = svg; host.style.position = 'relative';
    const tip = h('div', { class: 'tip', hidden: true }); host.append(tip);
    const svgEl = $('svg', host), cross = $('.cross', host), dots = $('.hover-dots', host);
    svgEl.setAttribute('aria-label', label);
    const move = (event) => {
      const rect = svgEl.getBoundingClientRect(); const px = (event.clientX - rect.left) * (width / rect.width);
      if (px < m.left || px > width - m.right) { leave(); return; }
      const t = t0 + (px - m.left) / iw * (t1 - t0);
      const rows = series.map((s) => { let best = s.pts[0]; for (const p of s.pts) if (Math.abs(p.ts - t) < Math.abs(best.ts - t)) best = p; return { s, p: best }; });
      const anchorTs = rows.reduce((a, r) => Math.abs(r.p.ts - t) < Math.abs(a - t) ? r.p.ts : a, rows[0].p.ts);
      cross.setAttribute('x1', X(anchorTs)); cross.setAttribute('x2', X(anchorTs)); cross.style.display = '';
      dots.innerHTML = rows.map((r) => `<circle cx="${X(r.p.ts).toFixed(1)}" cy="${Y(r.p.v).toFixed(1)}" r="4" fill="${r.s.color}" stroke="#fff" stroke-width="1.5"/>`).join('');
      tip.replaceChildren(h('div', { class: 'tip-time', text: fmtClock(anchorTs, false) }),
        ...rows.sort((a, b) => b.p.v - a.p.v).map((r) => h('div', { class: 'tip-row' }, h('i', { style: `background:${r.s.color}` }), h('span', { text: r.s.name }), h('b', { text: mode === 'index' ? `${r.p.v.toFixed(1)}%` : fmt(r.p.raw) }))));
      tip.hidden = false;
      const hostW = host.clientWidth; const left = X(anchorTs) / width * hostW;
      tip.style.left = `${Math.min(Math.max(8, left + 14), hostW - tip.offsetWidth - 8)}px`; tip.style.top = '8px';
    };
    const leave = () => { cross.style.display = 'none'; dots.innerHTML = ''; tip.hidden = true; };
    svgEl.addEventListener('pointermove', move); svgEl.addEventListener('pointerleave', leave);
  }

  // ---------- shared fragments ----------
  function gameIcon(game, name, size = 'md') {
    const box = h('span', { class: `icon ${size}`, 'aria-hidden': 'true' }, initial(name));
    if (game && game.iconUrl) {
      const img = h('img', { src: game.iconUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => box.replaceChildren(initial(name)), { once: true });
      box.replaceChildren(img);
    }
    return box;
  }
  function statusChip(id) {
    const s = record(id); const g = s.game;
    let cls = 'chip', text = 'รอข้อมูล';
    if (s.status === 'failed') { cls += ' bad'; text = 'ดึงข้อมูลไม่ได้'; }
    else if (s.status === 'stale') { cls += ' warn'; text = 'ข้อมูลเก่า'; }
    else if (g && g.isPlayable === false) { cls += ' warn'; text = 'จำกัดการเข้าถึง'; }
    else if (s.status === 'ok') { cls += ' good'; text = 'ปกติ'; }
    return h('span', { class: cls }, h('i'), text);
  }
  function deltaNode(stats) {
    if (!stats || stats.points.length < 2) return h('span', { class: 'muted', text: '—' });
    const cls = stats.delta > 0 ? 'up' : stats.delta < 0 ? 'down' : 'flat';
    return h('span', { class: `delta ${cls}` }, h('b', { text: fmtPct(stats.pct) }), h('small', { text: fmtSigned(stats.delta) }));
  }

  // ---------- views ----------
  function renderKpis() {
    const live = trackedGames.map((g) => ({ id: g.placeId, n: nowPlaying(g.placeId) })).filter((x) => x.n !== null && record(x.id).status === 'ok');
    const total = live.reduce((a, x) => a + x.n, 0);
    const top = live.slice().sort((a, b) => b.n - a.n)[0];
    let first = 0, last = 0, withSeries = 0;
    trackedGames.forEach((g) => { const st = seriesStats(g.placeId); if (st && st.points.length >= 2) { first += st.first; last += st.last; withSeries += 1; } });
    const pct = first > 0 ? (last - first) / first * 100 : 0;
    const okCount = trackedGames.filter((g) => record(g.placeId).status === 'ok').length;
    const rangeLabel = { '1h': '1 ชั่วโมง', '6h': '6 ชั่วโมง', '24h': '24 ชั่วโมง', '7d': '7 วัน', '30d': '30 วัน' }[range];
    const card = (label, value, note, cls = '') => h('div', { class: `kpi ${cls}` }, h('span', { class: 'kpi-label', text: label }), h('strong', { class: 'kpi-value', text: value }), h('span', { class: 'kpi-note', text: note }));
    els.kpis.replaceChildren(
      card('ผู้เล่นออนไลน์รวม', live.length ? fmt(total) : '—', live.length ? `จาก ${live.length} เกมที่ดึงข้อมูลได้` : 'ยังไม่มีข้อมูล'),
      card('เกมที่มีผู้เล่นมากที่สุด', top ? fmt(top.n) : '—', top ? gameName(top.id) : 'ยังไม่มีข้อมูล', 'kpi-name'),
      card(`เปลี่ยนแปลงรวมใน ${rangeLabel}`, withSeries >= 1 && first > 0 ? fmtPct(pct) : '—', withSeries ? `${fmtSigned(last - first)} คน จาก ${withSeries} เกม` : 'รอข้อมูลย้อนหลัง', last - first > 0 ? 'is-up' : last - first < 0 ? 'is-down' : ''),
      card('สถานะข้อมูล', `${okCount}/${trackedGames.length}`, trackedGames.length ? (okCount === trackedGames.length ? 'ทุกเกมอัปเดตปกติ' : 'บางเกมมีข้อมูลเก่าหรือดึงไม่ได้') : 'ยังไม่ได้เพิ่มเกม', okCount === trackedGames.length && trackedGames.length ? '' : trackedGames.length ? 'is-warn' : '')
    );
  }
  function emptyState() {
    return h('div', { class: 'panel empty' },
      h('div', { class: 'empty-symbol', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'), h('i')),
      h('h2', { text: 'เริ่มติดตามเกมแรกของคุณ' }),
      h('p', { text: `วาง Place ID หรือลิงก์เกมจาก roblox.com ในช่องด้านบน เพิ่มได้สูงสุด ${MAX_TRACKED_GAMES} เกม แล้วดูทุกเกมพร้อมกันในหน้านี้` }),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => els.placeId.focus() }, 'เพิ่มเกม'));
  }
  function renderOverview() {
    renderKpis();
    els.kpis.hidden = !trackedGames.length;
    $('.view-tools', els.tracking.closest('.view')).hidden = !trackedGames.length;
    els.tracking.textContent = trackedGames.length ? `ติดตาม ${trackedGames.length} จาก ${MAX_TRACKED_GAMES} เกม อัปเดตอัตโนมัติทุก ${refreshSeconds >= 60 ? refreshSeconds / 60 + ' นาที' : refreshSeconds + ' วินาที'} และพักเมื่อซ่อนแท็บ` : 'เพิ่มเกมเพื่อเริ่มติดตาม';
    $$('[data-layout]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.layout === layout)));
    if (!trackedGames.length) { els.overviewBody.replaceChildren(emptyState()); return; }
    const list = sortedGames();
    if (layout === 'wall') {
      const grid = h('div', { class: 'wall' });
      list.forEach((t) => {
        const id = t.placeId, s = record(id), g = s.game, st = seriesStats(id), color = colorFor(id);
        const card = h('article', { class: 'game-card' },
          h('a', { class: 'card-link', href: `#/game/${id}`, 'aria-label': `ดูรายละเอียด ${gameName(id)}` }),
          h('header', {}, gameIcon(g, gameName(id)), h('div', { class: 'card-title' }, h('strong', { text: gameName(id) }), h('span', { text: g && g.creatorName ? `โดย ${g.creatorName}` : `Place ${id}` })), statusChip(id)),
          h('div', { class: 'card-metrics' }, h('div', {}, h('span', { class: 'metric-label', text: 'ผู้เล่นตอนนี้' }), h('strong', { class: 'metric-big', text: fmt(nowPlaying(id)) })), deltaNode(st)),
          h('div', { class: 'card-chart' }, sparkline(st && st.points, color, 280, 56, true)),
          h('footer', {}, h('span', { text: `ยอดเข้าชม ${fmtCompact(g && g.visits)}` }), h('span', { text: g && num(g.maxPlayers) ? `${fmt(g.maxPlayers)} คน/เซิร์ฟเวอร์` : 'ขนาดเซิร์ฟเวอร์ —' })));
        grid.append(card);
      });
      els.overviewBody.replaceChildren(grid); return;
    }
    const head = ['เกม', 'ผู้เล่นตอนนี้', 'เปลี่ยนแปลง', 'แนวโน้ม', 'ผู้เล่น/เซิร์ฟเวอร์', 'ยอดเข้าชม', 'สถานะ', ''];
    const table = h('table', { class: 'data-table' },
      h('caption', { class: 'sr-only', text: 'รายการเกมที่ติดตาม' }),
      h('thead', {}, h('tr', {}, head.map((t, i) => h('th', { scope: 'col', class: i >= 1 && i <= 2 || i === 4 || i === 5 ? 'num' : '' }, t || h('span', { class: 'sr-only', text: 'การดำเนินการ' }))))),
      h('tbody', {}, list.map((t) => {
        const id = t.placeId, s = record(id), g = s.game, st = seriesStats(id), color = colorFor(id);
        return h('tr', { class: `row-${s.status}` },
          h('th', { scope: 'row', class: 'game-cell' }, h('a', { href: `#/game/${id}`, class: 'game-link' }, gameIcon(g, gameName(id), 'sm'), h('span', { class: 'game-name' }, h('strong', { text: gameName(id) }), h('small', { text: g && g.creatorName ? `โดย ${g.creatorName}` : `Place ${id}` })))),
          h('td', { class: 'num strong', text: fmt(nowPlaying(id)) }),
          h('td', { class: 'num' }, deltaNode(st)),
          h('td', { class: 'spark-cell' }, sparkline(st && st.points, color, 132, 34, false)),
          h('td', { class: 'num', text: fmt(g && g.maxPlayers) }),
          h('td', { class: 'num', text: fmtCompact(g && g.visits) }),
          h('td', {}, statusChip(id)),
          h('td', { class: 'act' }, h('button', { class: 'btn btn-quiet small', type: 'button', 'aria-label': `นำ ${gameName(id)} ออก`, onclick: () => removeGame(id) }, 'นำออก')));
      })));
    els.overviewBody.replaceChildren(h('div', { class: 'panel table-panel' }, h('div', { class: 'table-scroll' }, table)));
  }

  function renderCompare() {
    els.rangeB.value = range;
    $$('[data-metric]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.metric === metric)));
    if (!trackedGames.length) { els.compareBody.replaceChildren(emptyState()); return; }
    const legend = h('div', { class: 'legend', role: 'group', 'aria-label': 'เลือกเกมที่แสดงในกราฟ' });
    trackedGames.forEach((t) => {
      const id = t.placeId, off = hiddenSeries.has(id);
      legend.append(h('button', { type: 'button', class: `legend-item${off ? ' off' : ''}`, 'aria-pressed': String(!off), onclick: () => { if (off) hiddenSeries.delete(id); else hiddenSeries.add(id); safeWrite(STORAGE.hidden, [...hiddenSeries]); renderCompare(); } },
        h('i', { style: `background:${colorFor(id)}` }), gameName(id)));
    });
    const host = h('div', { class: 'chart-host', role: 'group', 'aria-label': 'กราฟเปรียบเทียบจำนวนผู้เล่น' });
    const rows = trackedGames.map((t) => {
      const id = t.placeId, st = seriesStats(id), g = record(id).game;
      return h('tr', {}, h('th', { scope: 'row', class: 'game-cell' }, h('span', { class: 'swatch', style: `background:${colorFor(id)}` }), h('a', { href: `#/game/${id}`, text: gameName(id) })),
        h('td', { class: 'num strong', text: fmt(g && g.playing) }), h('td', { class: 'num', text: st ? fmt(st.peak) : '—' }), h('td', { class: 'num', text: st ? fmt(st.avg) : '—' }), h('td', { class: 'num' }, deltaNode(st)));
    });
    els.compareBody.replaceChildren(
      h('div', { class: 'panel chart-panel' }, legend, host, h('p', { class: 'chart-note', text: seriesSource === 'mixed' ? 'แหล่งข้อมูล: Cloudflare D1 และประวัติในเบราว์เซอร์นี้' : seriesSource === 'd1' ? 'แหล่งข้อมูล: ประวัติบน Cloudflare D1 (เก็บต่อเนื่องแม้ปิดหน้านี้)' : 'แหล่งข้อมูล: ประวัติในเบราว์เซอร์นี้ จะสะสมเมื่อเปิดหน้านี้ไว้เท่านั้น' })),
      h('div', { class: 'panel table-panel' }, h('div', { class: 'table-scroll' }, h('table', { class: 'data-table compact' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'เกม' }), h('th', { scope: 'col', class: 'num', text: 'ตอนนี้' }), h('th', { scope: 'col', class: 'num', text: 'สูงสุดในช่วง' }), h('th', { scope: 'col', class: 'num', text: 'เฉลี่ย' }), h('th', { scope: 'col', class: 'num', text: 'เปลี่ยนแปลง' }))),
        h('tbody', {}, rows)))));
    const items = trackedGames.filter((t) => !hiddenSeries.has(t.placeId)).map((t) => ({ id: t.placeId, name: gameName(t.placeId), color: colorFor(t.placeId), points: (seriesByGame[t.placeId] || []) }));
    if (!items.length) { host.append(h('p', { class: 'chart-empty', text: 'เลือกชื่อเกมด้านบนเพื่อแสดงกราฟ' })); return; }
    lineChart(host, items, { height: 340, mode: metric, label: 'กราฟเปรียบเทียบจำนวนผู้เล่นออนไลน์ของทุกเกม' });
  }

  function renderGame() {
    const id = currentPlaceId;
    if (!id || !trackedGames.some((g) => g.placeId === id)) { els.gameBody.replaceChildren(h('div', { class: 'panel empty' }, h('h2', { text: 'ไม่พบเกมนี้ในรายการ' }), h('p', { text: 'เกมอาจถูกนำออกแล้ว กลับไปที่ภาพรวมเพื่อเลือกเกมอื่นหรือเพิ่มเกมใหม่' }), h('a', { class: 'btn btn-primary', href: '#/overview' }, 'กลับไปภาพรวม'))); return; }
    const s = record(id), g = s.game, st = seriesStats(id);
    const stat = (label, value, note) => h('div', { class: 'stat' }, h('span', { class: 'kpi-label', text: label }), h('strong', { class: 'kpi-value', text: value }), h('span', { class: 'kpi-note', text: note }));
    const host = h('div', { class: 'chart-host', role: 'group', 'aria-label': 'กราฟจำนวนผู้เล่นของเกมนี้' });
    const dl = (rows) => h('dl', { class: 'detail-list' }, rows.map(([k, v]) => h('div', {}, h('dt', { text: k }), h('dd', { text: v }))));
    const recent = (seriesByGame[id] || []).slice(-6).reverse();
    els.gameBody.replaceChildren(
      h('a', { class: 'back-link', href: '#/overview' }, '‹ กลับไปภาพรวมทุกเกม'),
      h('div', { class: 'game-head panel' }, gameIcon(g, gameName(id), 'lg'),
        h('div', { class: 'game-head-text' }, h('h1', { id: 'h-game', text: gameName(id) }), h('p', { class: 'sub', text: g && g.creatorName ? `สร้างโดย ${g.creatorName}` : `Place ID ${id}` }), h('div', { class: 'game-head-meta' }, statusChip(id), h('span', { class: 'muted', text: s.lastChecked ? `อัปเดต ${fmtClock(s.lastChecked)}` : 'ยังไม่เคยดึงข้อมูล' }))),
        h('div', { class: 'game-head-actions' }, h('a', { class: 'btn btn-secondary', href: `https://www.roblox.com/games/${encodeURIComponent(id)}`, target: '_blank', rel: 'noopener noreferrer' }, 'เปิดหน้าเกมบน Roblox'), h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => removeGame(id) }, 'นำออกจากรายการ'))),
      h('div', { class: 'inline-alert', hidden: !s.error }, `ดึงข้อมูลล่าสุดไม่สำเร็จ: ${s.error || 'ไม่ทราบสาเหตุ'} ${s.status === 'stale' ? 'ตัวเลขด้านล่างเป็นข้อมูลก่อนหน้า' : ''}`),
      h('div', { class: 'stat-row' },
        stat('ผู้เล่นออนไลน์', fmt(g && g.playing), 'ณ เวลาที่ดึงข้อมูลล่าสุด'),
        stat('ผู้เล่นสูงสุดต่อเซิร์ฟเวอร์', fmt(g && g.maxPlayers), 'ค่าความจุของแต่ละเซิร์ฟเวอร์'),
        stat('ยอดเข้าเล่นสะสม', fmt(g && g.visits), 'ตามข้อมูลสาธารณะของ Roblox'),
        stat('ช่วงสูงสุด', st ? fmt(st.peak) : '—', st ? `เฉลี่ย ${fmt(st.avg)} คน` : 'รอข้อมูลย้อนหลัง')),
      h('div', { class: 'panel chart-panel' },
        h('div', { class: 'panel-head' }, h('div', {}, h('h2', { text: 'แนวโน้มผู้เล่นออนไลน์' }), h('p', { class: 'sub', text: st && st.points.length > 1 ? `${fmtPct(st.pct)} (${fmtSigned(st.delta)} คน) ในช่วงที่เลือก` : 'รอข้อมูลอย่างน้อย 2 จุดเพื่อคำนวณการเปลี่ยนแปลง' })),
          h('div', { class: 'view-tools' }, h('label', { class: 'select-wrap', for: 'rangeDetail' }, h('span', { class: 'label', text: 'ช่วงเวลา' }), (() => { const sel = h('select', { id: 'rangeDetail' }, [['1h', '1 ชั่วโมง'], ['6h', '6 ชั่วโมง'], ['24h', '24 ชั่วโมง'], ['7d', '7 วัน'], ['30d', '30 วัน']].map(([v, t]) => h('option', { value: v, text: t }))); sel.value = range; sel.addEventListener('change', () => setRange(sel.value)); return sel; })()), h('button', { class: 'btn btn-secondary', type: 'button', onclick: exportCsv }, 'ส่งออก CSV'))),
        host, h('p', { class: 'chart-note', text: seriesSource === 'mixed' ? 'แหล่งข้อมูล: Cloudflare D1 และประวัติในเบราว์เซอร์นี้' : seriesSource === 'd1' ? 'แหล่งข้อมูล: Cloudflare D1' : 'แหล่งข้อมูล: ประวัติในเบราว์เซอร์นี้' })),
      h('div', { class: 'two-col' },
        h('div', { class: 'panel' }, h('h3', { text: 'ขนาดเซิร์ฟเวอร์' }),
          h('div', { class: 'cap' }, h('strong', { text: g && num(g.maxPlayers) ? fmt(g.maxPlayers) : '—' }), h('span', { text: 'ผู้เล่นสูงสุดต่อเซิร์ฟเวอร์' })),
          h('p', { class: 'cap-est', text: g && num(g.maxPlayers) > 0 && num(g.playing) !== null ? `ต้องมีอย่างน้อย ${fmt(Math.ceil(g.playing / g.maxPlayers))} เซิร์ฟเวอร์เปิดอยู่เพื่อรองรับผู้เล่นขณะนี้` : 'API ไม่ได้ส่งค่าความจุ' }),
          h('p', { class: 'muted small-note', text: 'Roblox เปิดเผยเฉพาะขนาดเซิร์ฟเวอร์ ไม่ได้บอกจำนวนเซิร์ฟเวอร์จริง ตัวเลขข้างต้นจึงเป็นค่าต่ำสุดที่คำนวณได้' })),
        h('div', { class: 'panel' }, h('h3', { text: 'รายละเอียดเกม' }), dl([['Place ID', id], ['Universe ID', g && g.universeId != null ? String(g.universeId) : '—'], ['Creator ID', g && g.creatorId != null ? String(g.creatorId) : '—'], ['การเข้าถึง', g ? (g.isPlayable === false ? 'จำกัดการเข้าถึง' : g.isPlayable === true ? 'เปิดให้เล่น' : 'ยืนยันไม่ได้') : '—']]))),
      h('div', { class: 'panel' }, h('h3', { text: 'ข้อมูลที่บันทึกล่าสุด' }),
        recent.length ? h('ul', { class: 'check-list' }, recent.map((p) => h('li', {}, h('span', { text: fmtClock(p.ts, false) }), h('b', { text: `${fmt(p.playing)} คน` })))) : h('p', { class: 'muted', text: 'ยังไม่มีข้อมูลที่บันทึกในช่วงนี้' })));
    lineChart(host, [{ id, name: gameName(id), color: colorFor(id), points: seriesByGame[id] || [] }], { height: 300, area: true, label: `กราฟจำนวนผู้เล่นของ ${gameName(id)}` });
  }

  function exportCsv() {
    const id = currentPlaceId, pts = seriesByGame[id] || [];
    if (!id || !pts.length) { setMessage('ไม่มีข้อมูลในช่วงเวลานี้ให้ส่งออก', 'warning'); return; }
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['timestamp_iso', 'place_id', 'game_name', 'playing', 'max_players', 'visits'], ...pts.map((p) => [new Date(p.ts).toISOString(), id, gameName(id), p.playing, p.maxPlayers ?? '', p.visits ?? ''])];
    const blob = new Blob(['﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob); const a = h('a', { href: url, download: `roblox-monitor-${id}-${range}.csv` });
    document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    setMessage(`ส่งออก CSV แล้ว ${pts.length} จุดข้อมูล`, 'success');
  }

  // ---------- events ----------
  const loadEvents = () => { const v = safeRead(STORAGE.events, []); return Array.isArray(v) ? v.filter(e => e && typeof e === 'object').slice(0, MAX_EVENTS) : []; };
  function pushEvent(type, title, detail, placeId = null, notify = true) {
    const events = loadEvents();
    events.unshift({ id: `${Date.now()}-${Math.random().toString(16).slice(2, 7)}`, type, title, detail, placeId, ts: Date.now() });
    safeWrite(STORAGE.events, events.slice(0, MAX_EVENTS));
    if (notify && notificationsEnabled && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification(title, { body: detail, tag: `rgm-${placeId || 'system'}` }); } catch (_) { /* blocked by browser policy */ }
    }
  }
  function renderEvents() {
    const events = loadEvents();
    els.navEvents.textContent = String(events.length); els.navEvents.classList.toggle('hidden', !events.length);
    els.alertLog.replaceChildren();
    if (!events.length) { els.alertLog.append(h('div', { class: 'empty-inline' }, h('strong', { text: 'ยังไม่มีการแจ้งเตือน' }), h('span', { text: 'เมื่อจำนวนผู้เล่นข้ามเกณฑ์หรือดึงข้อมูลไม่สำเร็จ รายการจะแสดงที่นี่' }))); return; }
    events.forEach((e) => els.alertLog.append(h('div', { class: `event ${e.type || ''}` }, h('i', { class: 'event-mark' }), h('div', { class: 'event-copy' }, h('strong', { text: e.title }), h('span', { text: e.detail || '' })), h('time', { text: fmtClock(e.ts, false) }))));
  }
  // Fires only when a game crosses a limit; the crossing state is persisted so reloads do not repeat alerts.
  function detectAlerts(next) {
    const all = readAlertState(); const st = all[next.placeId] || { above: false };
    const above = next.playing !== null && next.playing >= playerThreshold;
    if (above && !st.above) pushEvent('warning', 'ผู้เล่นถึงเกณฑ์ที่ตั้งไว้', `${next.name}: ${fmt(next.playing)} คน (เกณฑ์ ${fmt(playerThreshold)} คน)`, next.placeId);
    all[next.placeId] = { above }; safeWrite(STORAGE.alertState, all);
  }
  function updateNotifButton() { $('span', els.notifToggle).textContent = notificationsEnabled ? 'ปิดแจ้งเตือนในเบราว์เซอร์' : 'เปิดแจ้งเตือนในเบราว์เซอร์'; els.notifToggle.setAttribute('aria-pressed', String(notificationsEnabled)); }
  async function toggleNotifications() {
    if (!('Notification' in window)) { setMessage('เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน ใช้รายการในหน้านี้แทนได้', 'warning'); return; }
    if (notificationsEnabled) { notificationsEnabled = false; safeWrite(STORAGE.notifications, false); updateNotifButton(); setMessage('ปิดการแจ้งเตือนในเบราว์เซอร์แล้ว', 'success'); return; }
    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();
    if (permission !== 'granted') { setMessage('เบราว์เซอร์ยังไม่อนุญาตการแจ้งเตือน ตรวจสอบสิทธิ์ของเว็บไซต์ในการตั้งค่าเบราว์เซอร์', 'warning'); return; }
    notificationsEnabled = true; safeWrite(STORAGE.notifications, true); updateNotifButton();
    setMessage('เปิดการแจ้งเตือนแล้ว ใช้ได้ขณะเปิดหน้านี้ไว้', 'success');
  }

  // ---------- routing & render ----------
  function parseHash() {
    const m = location.hash.match(/^#\/([a-z]+)(?:\/(\d+))?/);
    const name = m && VIEWS.includes(m[1]) ? m[1] : 'overview';
    return { name, id: m && m[2] ? validPlaceId(m[2]) : null };
  }
  function navigate(name, id) { location.hash = id ? `#/${name}/${id}` : `#/${name}`; }
  function applyRoute() {
    const r = parseHash(); view = r.name;
    if (view === 'game') { if (r.id) { currentPlaceId = r.id; if (trackedGames.some(g => g.placeId === r.id)) persistTracked(); } else if (!currentPlaceId) view = 'overview'; }
    $$('.view').forEach((s) => { s.hidden = s.dataset.view !== view; });
    $$('[data-nav]').forEach((a) => { const active = a.dataset.nav === view || (view === 'game' && a.dataset.nav === 'overview'); a.classList.toggle('active', active); if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    const titles = { overview: 'ภาพรวมทุกเกม', compare: 'เปรียบเทียบเกม', game: currentPlaceId ? gameName(currentPlaceId) : 'รายละเอียดเกม', events: 'การแจ้งเตือน', policy: 'ขอบเขตและนโยบายข้อมูล' };
    document.title = `${titles[view]} · Roblox Game Monitor`;
    renderAll(); window.scrollTo(0, 0);
  }
  function renderAll() {
    els.navCount.textContent = String(trackedGames.length);
    els.rangeA.value = range; els.sort.value = sortBy;
    if (view === 'overview') renderOverview();
    else if (view === 'compare') renderCompare();
    else if (view === 'game') renderGame();
    renderEvents();
  }
  async function setRange(value) {
    if (!RANGE_MS[value]) return;
    range = value;
    const cutoff = Date.now() - RANGE_MS[value];
    seriesByGame = Object.fromEntries(trackedGames.map(({ placeId }) => [placeId, readLocalHistory(placeId).filter(p => p.ts >= cutoff)]));
    seriesSource = 'local';
    renderAll();
    safeWrite(STORAGE.range, value); els.rangeA.value = value; els.rangeB.value = value;
    try { await loadSeries(); } catch (_) { /* local */ }
    renderAll();
  }

  // ---------- timers ----------
  function scheduleNextRefresh() {
    clearTimeout(refreshTimer); refreshTimer = null; nextRefreshAt = null;
    if (!trackedGames.length || document.hidden) { updateCountdown(); return; }
    nextRefreshAt = Date.now() + refreshSeconds * 1000;
    refreshTimer = setTimeout(() => refreshTracked({ quiet: true }), refreshSeconds * 1000);
    updateCountdown();
  }
  function updateCountdown() {
    if (document.hidden) { els.countdown.textContent = 'พักเมื่อซ่อนแท็บ'; return; }
    if (!trackedGames.length) { els.countdown.textContent = 'ยังไม่มีเกม'; return; }
    if (!nextRefreshAt) { els.countdown.textContent = activeRequest ? 'กำลังอัปเดต…' : 'พร้อมอัปเดต'; return; }
    els.countdown.textContent = `อัปเดตใน ${Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000))} วินาที`;
  }

  // ---------- events wiring ----------
  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const id = parsePlaceId(els.placeId.value);
    if (!id) { setMessage('Place ID ต้องเป็นตัวเลข หรือลิงก์เกมจาก roblox.com/games/…', 'error'); els.placeId.focus(); return; }
    const result = addGame(id);
    if (result === 'full') { setMessage(`รายการเต็มแล้ว (${MAX_TRACKED_GAMES} เกม) นำเกมที่ไม่ใช้ออกก่อนจึงจะเพิ่มได้`, 'warning'); return; }
    els.placeId.value = '';
    if (result === 'exists') { navigate('game', id); setMessage('เกมนี้อยู่ในรายการแล้ว', 'warning'); return; }
    if (view !== 'overview') navigate('overview');
    setMessage('เพิ่มเกมแล้ว กำลังดึงข้อมูลล่าสุด…');
    renderAll(); refreshTracked({ quiet: false });
  });
  els.refreshNow.addEventListener('click', () => { clearTimeout(refreshTimer); refreshTracked({ quiet: false }); });
  els.refreshInterval.addEventListener('change', () => { refreshSeconds = Math.max(DEFAULT_REFRESH_SECONDS, Number(els.refreshInterval.value) || DEFAULT_REFRESH_SECONDS); renderAll(); scheduleNextRefresh(); });
  els.rangeA.addEventListener('change', () => setRange(els.rangeA.value));
  els.rangeB.addEventListener('change', () => setRange(els.rangeB.value));
  els.sort.addEventListener('change', () => { sortBy = els.sort.value; safeWrite(STORAGE.sort, sortBy); renderAll(); });
  $$('[data-layout]').forEach((b) => b.addEventListener('click', () => { layout = b.dataset.layout; safeWrite(STORAGE.layout, layout); renderAll(); }));
  $$('[data-metric]').forEach((b) => b.addEventListener('click', () => { metric = b.dataset.metric; safeWrite(STORAGE.metric, metric); renderAll(); }));
  $('.banner-close', els.message).addEventListener('click', () => { els.message.hidden = true; });
  els.threshold.addEventListener('change', () => {
    const value = Math.floor(Number(els.threshold.value));
    if (!Number.isFinite(value) || value < 1) { els.threshold.value = String(playerThreshold); return; }
    playerThreshold = Math.min(value, 100000000); els.threshold.value = String(playerThreshold); safeWrite(STORAGE.threshold, playerThreshold);
    safeWrite(STORAGE.alertState, {}); // re-evaluate each game against the new limit
    setMessage(`ตั้งเกณฑ์แจ้งเตือนที่ ${fmt(playerThreshold)} คนแล้ว`, 'success');
  });
  els.notifToggle.addEventListener('click', toggleNotifications);
  els.clearEvents.addEventListener('click', () => { safeWrite(STORAGE.events, []); renderEvents(); setMessage('ล้างประวัติการแจ้งเตือนแล้ว', 'success'); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(refreshTimer); refreshTimer = null; nextRefreshAt = null; updateCountdown(); }
    else if (trackedGames.length) refreshTracked({ quiet: true });
  });
  window.addEventListener('hashchange', applyRoute);
  let resizeTimer = null; let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (window.innerWidth !== lastWidth) { lastWidth = window.innerWidth; if (view === 'compare' || view === 'game') renderAll(); } }, 150); });

  // ---------- init ----------
  async function initialize() {
    const t = Number(safeRead(STORAGE.threshold, DEFAULT_PLAYER_THRESHOLD));
    if (Number.isFinite(t) && t >= 1) playerThreshold = Math.min(Math.floor(t), 100000000);
    els.threshold.value = String(playerThreshold);
    notificationsEnabled = safeRead(STORAGE.notifications, false) === true && 'Notification' in window && Notification.permission === 'granted';
    updateNotifButton(); loadTracked();
    trackedGames.forEach((g) => { const local = readLocalHistory(g.placeId); seriesByGame[g.placeId] = local.filter((p) => p.ts >= Date.now() - RANGE_MS[range]); });
    applyRoute();
    setInterval(updateCountdown, 1000);
    await checkApiHealth();
    if (trackedGames.length) await refreshTracked({ quiet: true });
    else if (!apiHealth.online) setMessage('โหลดหน้าเว็บแล้ว แต่ยังติดต่อ API ไม่ได้ ตรวจสอบว่า deploy Worker แล้ว', 'warning');
  }
  initialize();
})();
