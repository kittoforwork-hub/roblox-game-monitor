'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const STORAGE = {
    tracked: 'robloxMonitorTrackedGames',
    active: 'robloxMonitorPlaceId',
    recent: 'robloxMonitorRecentGames',
    historyPrefix: 'robloxMonitorHistory:',
    events: 'robloxMonitorEvents',
    threshold: 'robloxMonitorPlayerThreshold',
    notifications: 'robloxMonitorNotifications'
  };
  const MAX_TRACKED_GAMES = 10;
  const MAX_RECENT_GAMES = 5;
  const MAX_LOCAL_SAMPLES = 1500;
  const MAX_EVENTS = 30;
  const DEFAULT_REFRESH_SECONDS = 60;
  const DEFAULT_PLAYER_THRESHOLD = 100;
  const HISTORY_RANGE_MS = { '1h': 60 * 60 * 1000, '6h': 6 * 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000, '30d': 30 * 24 * 60 * 60 * 1000 };

  const els = {
    placeId: $('#placeId'), gameForm: $('#gameForm'), checkBtn: $('#checkBtn'), message: $('#message'), messageText: $('.message-text'), results: $('#results'),
    refreshNow: $('#refreshNow'), refreshInterval: $('#refreshInterval'), countdown: $('#countdown'), recentGames: $('#recentGames'), trackedGrid: $('#trackedGamesGrid'),
    trackedCount: $('#trackedGameCount'), trackedCountBadge: $('#trackedCountBadge'), trackingStatus: $('#trackingStatus'), clearTracked: $('#clearTrackedGames'),
    playerThreshold: $('#playerThreshold'), notificationsToggle: $('#notificationsToggle'), alertLog: $('#alertLog'), clearEvents: $('#clearEvents'),
    systemStatusDot: $('#systemStatusDot'), systemStatusText: $('#systemStatusText'), summaryStatusDot: $('#summaryStatusDot'), summaryStatus: $('#summaryStatus'),
    lastSuccessfulCheck: $('#lastSuccessfulCheck'), storageMode: $('#storageMode'), footerStorageMode: $('#footerStorageMode'), rangeSelector: $('#rangeSelector'), exportHistoryBtn: $('#exportHistoryBtn'),
    gameName: $('#gameName'), gameCreator: $('#gameCreator'), gameAvatarLetter: $('#gameAvatarLetter'), gameIcon: $('#gameIcon'), publicStatus: $('#publicStatus'), refreshedAt: $('#refreshedAt'), openGame: $('#openGame'),
    playing: $('#playing'), maxPlayers: $('#maxPlayers'), visits: $('#visits'), capacityPercent: $('#capacityPercent'), capacityFill: $('#capacityFill'), capacityCaption: $('#capacityCaption'),
    capacityRatio: $('#capacityRatio'), ringLabel: $('#ringLabel'), capacityRingFill: $('#capacityRingFill'), capacitySegments: $('#capacitySegments'), capacityNote: $('#capacityNote'),
    chartCurrent: $('#chartCurrent'), chartSamples: $('#chartSamples'), chartDelta: $('#chartDelta'), chartStart: $('#chartStart'), chartEnd: $('#chartEnd'), trendChart: $('#trendChart'),
    chartDataSource: $('#chartDataSource'), insightPeak: $('#insightPeak'), insightAverage: $('#insightAverage'), insightChange: $('#insightChange'), detailPlaceId: $('#detailPlaceId'),
    universeId: $('#universeId'), creatorId: $('#creatorId'), gameStatus: $('#gameStatus'), updatedAt: $('#updatedAt'), recentChecks: $('#recentChecks'), historyRetentionNote: $('#historyRetentionNote')
  };

  let trackedGames = [];
  const trackedState = new Map();
  let currentPlaceId = null;
  let currentGame = null;
  let currentHistory = [];
  let currentHistorySource = 'รอข้อมูล';
  let activeRequest = false;
  let refreshTimer = null;
  let countdownTimer = null;
  let nextRefreshAt = null;
  let refreshSeconds = DEFAULT_REFRESH_SECONDS;
  let playerThreshold = DEFAULT_PLAYER_THRESHOLD;
  let notificationsEnabled = false;
  let apiHealth = { checked: false, online: false, d1: false };
  let lastSuccessfulAt = null;

  function safeRead(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value == null ? fallback : JSON.parse(value);
    } catch (_) { return fallback; }
  }
  function safeWrite(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (_) { return false; }
  }
  function safeText(value, fallback = '—') {
    return value === null || value === undefined || value === '' ? fallback : String(value);
  }
  function numberValue(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  function formatNumber(value) {
    const n = numberValue(value);
    return n === null ? '—' : new Intl.NumberFormat('th-TH', { maximumFractionDigits: 0 }).format(n);
  }
  function formatCompact(value) {
    const n = numberValue(value);
    if (n === null) return '—';
    return new Intl.NumberFormat('th-TH', { notation: n >= 100000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
  }
  function formatTime(value, includeSeconds = true) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return new Intl.DateTimeFormat('th-TH', includeSeconds
      ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
      : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
  }
  function setMessage(text, type = '') {
    if (!els.messageText || !els.message) return;
    els.messageText.textContent = text;
    els.message.className = `message ${type}`.trim();
  }
  function setSystemStatus(label, type = 'ok') {
    const className = type === 'error' ? 'error' : type === 'warning' ? 'warning' : '';
    [els.systemStatusDot, els.summaryStatusDot].filter(Boolean).forEach((node) => {
      node.classList.remove('error', 'warning');
      if (className) node.classList.add(className);
    });
    if (els.systemStatusText) els.systemStatusText.textContent = label;
    if (els.summaryStatus) els.summaryStatus.textContent = type === 'error' ? 'SERVICE DEGRADED' : type === 'warning' ? 'PARTIAL DATA' : 'READY TO MONITOR';
  }
  function setLoading(loading) {
    if (els.checkBtn) {
      els.checkBtn.disabled = loading;
      els.checkBtn.classList.toggle('loading', loading);
      const label = $('.button-label', els.checkBtn);
      if (label) label.textContent = loading ? 'กำลังตรวจสอบ…' : 'เพิ่มและตรวจสอบ';
    }
    if (els.refreshNow) {
      els.refreshNow.disabled = loading;
      els.refreshNow.classList.toggle('spinning', loading);
    }
  }
  function countUp(element, target) {
    if (!element) return;
    const end = numberValue(target);
    if (end === null) { element.textContent = '—'; return; }
    const start = numberValue(element.dataset.value) ?? 0;
    element.dataset.value = String(end);
    if (start === end || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      element.textContent = formatNumber(end);
      return;
    }
    const startAt = performance.now();
    const duration = 420;
    element.classList.remove('number-pop');
    void element.offsetWidth;
    element.classList.add('number-pop');
    function animate(now) {
      const progress = Math.min(1, (now - startAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      element.textContent = formatNumber(Math.round(start + (end - start) * eased));
      if (progress < 1) requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
  }
  function validPlaceId(value) {
    const id = String(value ?? '').trim();
    return /^\d{1,20}$/.test(id) && BigInt(id) > 0n ? id : null;
  }
  function parsePlaceId(rawValue) {
    const raw = String(rawValue || '').trim();
    const match = raw.match(/roblox\.com\/games\/(\d+)/i) || raw.match(/(?:^|\D)(\d{1,20})(?:\D|$)/);
    return validPlaceId(match ? match[1] : raw);
  }
  function historyKey(placeId) { return `${STORAGE.historyPrefix}${placeId}`; }
  function readLocalHistory(placeId) {
    const stored = safeRead(historyKey(placeId), []);
    if (!Array.isArray(stored)) return [];
    const cutoff = Date.now() - HISTORY_RANGE_MS['30d'];
    return stored.filter((point) => point && Number.isFinite(Number(point.ts)) && Number(point.ts) >= cutoff && numberValue(point.playing) !== null)
      .map((point) => ({ ts: Number(point.ts), playing: Number(point.playing), maxPlayers: numberValue(point.maxPlayers), visits: numberValue(point.visits), sampleCount: point.sampleCount || 1 }))
      .sort((a, b) => a.ts - b.ts).slice(-MAX_LOCAL_SAMPLES);
  }
  function saveLocalSnapshot(game) {
    if (!game || !game.placeId || numberValue(game.playing) === null) return;
    const history = readLocalHistory(game.placeId);
    const ts = numberValue(game.checkedAt) || Date.now();
    const last = history[history.length - 1];
    // Prevent duplicate points from the same worker snapshot timestamp.
    if (last && Math.abs(last.ts - ts) < 1000) return;
    history.push({ ts, playing: Number(game.playing), maxPlayers: numberValue(game.maxPlayers), visits: numberValue(game.visits), sampleCount: 1 });
    safeWrite(historyKey(game.placeId), history.slice(-MAX_LOCAL_SAMPLES));
  }
  function readRecentGames() {
    const stored = safeRead(STORAGE.recent, []);
    return Array.isArray(stored) ? stored.slice(0, MAX_RECENT_GAMES) : [];
  }
  function saveRecentGame(game) {
    const list = readRecentGames().filter((item) => String(item.placeId) !== String(game.placeId));
    list.unshift({ placeId: String(game.placeId), name: game.name || `เกม ${game.placeId}` });
    safeWrite(STORAGE.recent, list.slice(0, MAX_RECENT_GAMES));
    renderRecentGames();
  }
  function loadTrackedGamesFromStorage() {
    const stored = safeRead(STORAGE.tracked, []);
    const source = Array.isArray(stored) ? stored : [];
    trackedGames = source.map((item) => ({ placeId: validPlaceId(item && item.placeId), name: String((item && item.name) || '') }))
      .filter((item) => item.placeId).slice(0, MAX_TRACKED_GAMES);
    // Migrate earlier versions which saved only the current game and last-visited games.
    if (!trackedGames.length) {
      const savedCurrent = validPlaceId(localStorageSafeGet(STORAGE.active));
      const olderRecent = readRecentGames().map((item) => ({ placeId: validPlaceId(item.placeId), name: String(item.name || '') })).filter((item) => item.placeId);
      const seeds = savedCurrent ? [{ placeId: savedCurrent, name: '' }, ...olderRecent] : olderRecent;
      const unique = new Map();
      seeds.forEach((item) => { if (item.placeId && !unique.has(item.placeId)) unique.set(item.placeId, item); });
      trackedGames = Array.from(unique.values()).slice(0, MAX_TRACKED_GAMES);
      safeWrite(STORAGE.tracked, trackedGames);
    }
    trackedGames.forEach((item) => trackedState.set(item.placeId, { game: item.name ? { placeId: item.placeId, name: item.name } : null, status: 'idle', error: null, lastChecked: null }));
    const savedActive = validPlaceId(localStorageSafeGet(STORAGE.active));
    currentPlaceId = (savedActive && trackedGames.some((item) => item.placeId === savedActive) ? savedActive : trackedGames[0]?.placeId) || null;
  }
  function localStorageSafeGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function persistTrackedGames() {
    safeWrite(STORAGE.tracked, trackedGames);
    try {
      if (currentPlaceId) localStorage.setItem(STORAGE.active, currentPlaceId);
      else localStorage.removeItem(STORAGE.active);
    } catch (_) { /* Private browsing can disable storage. */ }
    updateTrackedCount();
  }
  function updateTrackedCount() {
    const text = `${trackedGames.length} / ${MAX_TRACKED_GAMES}`;
    if (els.trackedCount) els.trackedCount.textContent = text;
    if (els.trackedCountBadge) els.trackedCountBadge.textContent = String(trackedGames.length);
    if (els.trackingStatus) els.trackingStatus.textContent = trackedGames.length
      ? `ติดตาม ${trackedGames.length} เกม · รีเฟรชทุก ${refreshSeconds >= 60 ? (refreshSeconds / 60) + ' นาที' : refreshSeconds + ' วินาที'} · หยุดตรวจสอบเมื่อแท็บถูกซ่อน`
      : 'เพิ่มเกมเพื่อเริ่มติดตาม';
  }
  function renderRecentGames() {
    if (!els.recentGames) return;
    const games = readRecentGames();
    els.recentGames.replaceChildren();
    if (!games.length) { els.recentGames.classList.add('hidden'); return; }
    els.recentGames.classList.remove('hidden');
    const label = document.createElement('span');
    label.className = 'recent-games-label';
    label.textContent = 'RECENT';
    els.recentGames.append(label);
    games.forEach((game) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'recent-game-chip';
      button.dataset.placeId = String(game.placeId);
      const name = document.createElement('span');
      name.textContent = game.name || `เกม ${game.placeId}`;
      button.append(name);
      els.recentGames.append(button);
    });
  }
  function getTrackedRecord(placeId) {
    if (!trackedState.has(placeId)) trackedState.set(placeId, { game: null, status: 'idle', error: null, lastChecked: null });
    return trackedState.get(placeId);
  }
  function renderTrackedGames() {
    if (!els.trackedGrid) return;
    els.trackedGrid.replaceChildren();
    updateTrackedCount();
    if (!trackedGames.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-tracked';
      const symbol = document.createElement('span'); symbol.className = 'empty-symbol'; symbol.textContent = '+';
      const title = document.createElement('strong'); title.textContent = 'ยังไม่มีเกมใน Workspace';
      const copy = document.createElement('p'); copy.textContent = 'เพิ่ม Place ID ด้านบนเพื่อเริ่มติดตามเกมและเก็บประวัติ';
      empty.append(symbol, title, copy); els.trackedGrid.append(empty); return;
    }
    trackedGames.forEach((tracked) => {
      const state = getTrackedRecord(tracked.placeId);
      const game = state.game || tracked;
      const card = document.createElement('article');
      card.className = `tracked-card${tracked.placeId === currentPlaceId ? ' is-selected' : ''}`;
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `เลือกเกม ${game.name || tracked.placeId}`);
      card.dataset.placeId = tracked.placeId;

      const top = document.createElement('div'); top.className = 'tracked-card-top';
      const avatar = document.createElement('span'); avatar.className = 'tracked-avatar';
      const iconUrl = game.iconUrl && /^https:\/\//i.test(game.iconUrl) ? game.iconUrl : null;
      if (iconUrl) { const img = document.createElement('img'); img.src = iconUrl; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; img.onerror = () => { avatar.replaceChildren(document.createTextNode((game.name || 'R').trim().charAt(0).toUpperCase())); }; avatar.append(img); }
      else avatar.textContent = (game.name || 'R').trim().charAt(0).toUpperCase();
      const nameWrap = document.createElement('span'); nameWrap.className = 'tracked-name-wrap';
      const name = document.createElement('span'); name.className = 'tracked-name'; name.textContent = game.name || `Place ${tracked.placeId}`;
      const creator = document.createElement('span'); creator.className = 'tracked-creator'; creator.textContent = game.creatorName ? `โดย ${game.creatorName}` : `PLACE ID ${tracked.placeId}`;
      nameWrap.append(name, creator); top.append(avatar, nameWrap);

      const health = document.createElement('div');
      health.className = `tracked-health${state.status === 'failed' ? ' failed' : state.status === 'stale' ? ' stale' : ''}`;
      const healthDot = document.createElement('i');
      const healthText = document.createElement('span');
      healthText.textContent = state.status === 'failed' ? 'ตรวจสอบไม่สำเร็จ' : state.status === 'stale' ? 'ข้อมูลเก่า' : state.status === 'ok' ? 'ตรวจสอบสำเร็จ' : 'รอข้อมูล';
      health.append(healthDot, healthText);

      const stats = document.createElement('div'); stats.className = 'tracked-stats';
      const playerBlock = document.createElement('div'); playerBlock.className = 'tracked-player'; playerBlock.textContent = state.status === 'failed' && !state.game ? '—' : formatNumber(game.playing);
      const playerCaption = document.createElement('small'); playerCaption.textContent = 'ผู้เล่นออนไลน์'; playerBlock.append(playerCaption);
      const visits = document.createElement('div'); visits.className = 'tracked-visits'; visits.textContent = 'ยอดเข้าชม';
      const visitsValue = document.createElement('b'); visitsValue.textContent = formatCompact(game.visits); visits.append(visitsValue);
      stats.append(playerBlock, visits);

      const bottom = document.createElement('div'); bottom.className = 'tracked-card-bottom';
      const last = document.createElement('span'); last.textContent = state.lastChecked ? `อัปเดต ${formatTime(state.lastChecked)}` : `PLACE ${tracked.placeId}`;
      const controls = document.createElement('span'); controls.className = 'tracked-card-controls';
      const open = document.createElement('span'); open.className = 'tracked-open'; open.textContent = tracked.placeId === currentPlaceId ? 'SELECTED' : 'VIEW ↗';
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'tracked-remove'; remove.dataset.removePlaceId = tracked.placeId; remove.setAttribute('aria-label', `นำเกม ${game.name || tracked.placeId} ออกจากรายการ`); remove.title = 'นำออก'; remove.textContent = '×';
      controls.append(open, remove); bottom.append(last, controls);
      card.append(top, health, stats, bottom);
      els.trackedGrid.append(card);
    });
  }
  function addTrackedGame(placeId) {
    const existing = trackedGames.find((game) => game.placeId === placeId);
    if (existing) return { added: false, full: false };
    if (trackedGames.length >= MAX_TRACKED_GAMES) return { added: false, full: true };
    trackedGames.unshift({ placeId, name: '' });
    trackedState.set(placeId, { game: null, status: 'idle', error: null, lastChecked: null });
    persistTrackedGames();
    renderTrackedGames();
    return { added: true, full: false };
  }
  function removeTrackedGame(placeId) {
    trackedGames = trackedGames.filter((game) => game.placeId !== placeId);
    trackedState.delete(placeId);
    if (currentPlaceId === placeId) currentPlaceId = trackedGames[0]?.placeId || null;
    persistTrackedGames();
    renderTrackedGames();
    if (!currentPlaceId) {
      currentGame = null; currentHistory = []; els.results.classList.add('hidden');
      setMessage('นำเกมออกจาก Workspace แล้ว เพิ่ม Place ID เพื่อเริ่มตรวจสอบใหม่', '');
      scheduleNextRefresh();
    } else if (currentGame && currentGame.placeId !== currentPlaceId) {
      const nextState = getTrackedRecord(currentPlaceId);
      if (nextState.game) { currentGame = nextState.game; renderGame(currentGame, nextState.status); loadCurrentHistory(); }
      else { refreshTracked({ quiet: false }); }
    }
  }

  async function requestJson(path, timeoutMs = 14000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path, { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
      const text = await response.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; }
      catch (_) {
        const parseError = new Error(response.ok ? 'API ไม่ได้ส่งข้อมูล JSON กลับมา ตรวจสอบ Worker/API route' : `เรียก API ไม่สำเร็จ (${response.status})`);
        parseError.status = response.status;
        throw parseError;
      }
      if (!response.ok) {
        const error = new Error(body.error || `เรียก API ไม่สำเร็จ (${response.status})`);
        error.status = response.status; error.code = body.code || ''; error.retryAfter = Number(response.headers.get('Retry-After')) || null;
        throw error;
      }
      return body;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('การตรวจสอบใช้เวลานานเกินกำหนด โปรดลองอีกครั้ง');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function fetchBatch(placeIds) {
    const query = encodeURIComponent(placeIds.join(','));
    try {
      return await requestJson(`/api/games?placeIds=${query}`);
    } catch (error) {
      // A compatibility path for older Workers that expose only /api/game.
      if (error.status !== 404) throw error;
      const games = [];
      for (const placeId of placeIds) {
        try { games.push({ ok: true, game: await requestJson(`/api/game?placeId=${encodeURIComponent(placeId)}`) }); }
        catch (itemError) { games.push({ ok: false, placeId, error: itemError.message }); }
      }
      return { games, storage: 'legacy' };
    }
  }
  async function checkApiHealth() {
    try {
      const health = await requestJson('/api/health', 6000);
      apiHealth = { checked: true, online: true, d1: Boolean(health.storage && health.storage.d1), version: health.version || '—' };
      if (apiHealth.d1) {
        els.storageMode.textContent = 'D1 persistent history'; els.footerStorageMode.textContent = 'D1 PERSISTENT HISTORY';
        els.historyRetentionNote.textContent = 'ประวัติหลักเก็บใน Cloudflare D1 สูงสุด 30 วัน พร้อม local fallback';
      } else {
        els.storageMode.textContent = 'Local history fallback'; els.footerStorageMode.textContent = 'LOCAL FALLBACK';
        els.historyRetentionNote.textContent = 'ฐานข้อมูล D1 ยังไม่พร้อม ประวัติหลักจึงเก็บในเบราว์เซอร์นี้เท่านั้น';
      }
      setSystemStatus(apiHealth.d1 ? 'API CONNECTED · D1' : 'API CONNECTED · LOCAL', apiHealth.d1 ? 'ok' : 'warning');
    } catch (_) {
      apiHealth = { checked: true, online: false, d1: false };
      if (els.storageMode) els.storageMode.textContent = 'API unavailable';
      if (els.footerStorageMode) els.footerStorageMode.textContent = 'API UNAVAILABLE';
      setSystemStatus('API UNAVAILABLE', 'error');
    }
  }
  function normalizedGame(raw, requestedPlaceId) {
    const g = raw && raw.game ? raw.game : raw;
    return {
      placeId: String(g.placeId || requestedPlaceId), universeId: g.universeId ?? null, name: g.name || `Place ${requestedPlaceId}`,
      description: g.description || '', creatorName: g.creatorName || '', creatorId: g.creatorId ?? null,
      isPlayable: typeof g.isPlayable === 'boolean' ? g.isPlayable : (typeof g.playable === 'boolean' ? g.playable : null),
      playing: numberValue(g.playing), maxPlayers: numberValue(g.maxPlayers), visits: numberValue(g.visits), iconUrl: g.iconUrl || '',
      updatedAt: g.updatedAt || null, checkedAt: numberValue(g.checkedAt) || Date.now(), cached: Boolean(g.cached)
    };
  }
  function updateTrackedFromGame(game) {
    const state = getTrackedRecord(game.placeId);
    const oldGame = state.game;
    detectAlerts(oldGame, game);
    state.game = game;
    state.status = 'ok'; state.error = null; state.lastChecked = game.checkedAt || Date.now();
    const item = trackedGames.find((entry) => entry.placeId === game.placeId);
    if (item && game.name) item.name = game.name;
    saveLocalSnapshot(game);
    saveRecentGame(game);
  }
  function markTrackedFailure(placeId, message) {
    const state = getTrackedRecord(placeId);
    const shouldLog = state.status !== 'failed' && state.status !== 'stale';
    state.status = state.game ? 'stale' : 'failed';
    state.error = message;
    if (shouldLog) pushEvent('error', 'ตรวจสอบข้อมูลไม่สำเร็จ', `${state.game?.name || `Place ${placeId}`} · ${message}`, placeId, false);
  }
  async function refreshTracked(options = {}) {
    const quiet = options.quiet !== false;
    if (activeRequest || !trackedGames.length) { scheduleNextRefresh(); return; }
    activeRequest = true;
    const placeIds = trackedGames.map((game) => game.placeId);
    const startedAt = Date.now();
    if (!quiet) { setLoading(true); setMessage(`กำลังตรวจสอบ ${placeIds.length} เกมผ่าน Roblox Public API…`); }
    try {
      const payload = await fetchBatch(placeIds);
      const results = Array.isArray(payload.games) ? payload.games : [];
      const successful = [];
      const failed = [];
      results.forEach((result) => {
        if (result && result.ok === false) {
          const placeId = validPlaceId(result.placeId);
          if (placeId) { markTrackedFailure(placeId, result.error || 'ไม่พบข้อมูลจาก API'); failed.push({ placeId, error: result.error || 'ตรวจสอบไม่สำเร็จ' }); }
          return;
        }
        const game = normalizedGame(result, result && result.placeId);
        if (!validPlaceId(game.placeId) || game.playing === null) {
          const placeId = validPlaceId((result && result.game && result.game.placeId) || (result && result.placeId));
          if (placeId) { markTrackedFailure(placeId, 'รูปแบบข้อมูลจาก API ไม่ครบถ้วน'); failed.push({ placeId, error: 'ข้อมูล API ไม่ครบถ้วน' }); }
          return;
        }
        updateTrackedFromGame(game);
        successful.push(game);
      });
      // Some API gateways can return only a subset; mark omitted tracked games as failed/stale.
      const returnedIds = new Set(results.map((r) => String((r && r.game && r.game.placeId) || (r && r.placeId) || '')));
      placeIds.filter((id) => !returnedIds.has(id)).forEach((id) => {
        markTrackedFailure(id, 'API ไม่ส่งผลลัพธ์สำหรับเกมนี้');
        failed.push({ placeId: id, error: 'API ไม่ส่งผลลัพธ์' });
      });
      renderTrackedGames();
      const selected = currentPlaceId && successful.find((game) => game.placeId === currentPlaceId);
      if (selected) {
        currentGame = selected;
        renderGame(selected, 'ok');
        await loadCurrentHistory();
      } else if (currentPlaceId) {
        const state = getTrackedRecord(currentPlaceId);
        if (state.game) { currentGame = state.game; renderGame(state.game, state.status); await loadCurrentHistory(); }
      }
      if (successful.length) {
        lastSuccessfulAt = Date.now();
        if (els.lastSuccessfulCheck) els.lastSuccessfulCheck.textContent = `ข้อมูลสำเร็จล่าสุด ${formatTime(lastSuccessfulAt)}`;
        if (failed.length) {
          setSystemStatus(`PARTIAL DATA · ${successful.length}/${placeIds.length}`, 'warning');
          if (!quiet) setMessage(`ตรวจสอบสำเร็จ ${successful.length} จาก ${placeIds.length} เกม มี ${failed.length} เกมที่อัปเดตไม่ได้ ข้อมูลเดิมยังแสดงเป็นข้อมูลเก่า`, 'warning');
          else setMessage(`อัปเดตแล้ว ${successful.length}/${placeIds.length} เกม · มีข้อมูลบางเกมไม่สำเร็จ`, 'warning');
        } else {
          setSystemStatus(apiHealth.d1 ? 'API CONNECTED · D1' : 'API CONNECTED · LOCAL', apiHealth.d1 ? 'ok' : 'warning');
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          setMessage(`อัปเดตข้อมูล ${successful.length} เกมสำเร็จ · ใช้เวลา ${elapsed} วินาที · ตรวจสอบอัตโนมัติทุก ${refreshSeconds} วินาที`, 'success');
        }
      } else {
        setSystemStatus('DATA UNAVAILABLE', 'error');
        setMessage('ไม่สามารถดึงข้อมูลเกมได้ ตรวจสอบ Worker, API route และสถานะ Roblox แล้วลองอีกครั้ง', 'error');
      }
    } catch (error) {
      setSystemStatus('CONNECTION ERROR', 'error');
      setMessage(`${error.message || 'เชื่อมต่อ API ไม่สำเร็จ'} · ข้อมูลเดิมถูกเก็บไว้และทำเครื่องหมายเป็นข้อมูลเก่า`, 'error');
      trackedGames.forEach((item) => markTrackedFailure(item.placeId, error.message || 'API unavailable'));
      renderTrackedGames();
      if (currentPlaceId) {
        const state = getTrackedRecord(currentPlaceId);
        if (state.game) { currentGame = state.game; renderGame(state.game, 'stale'); }
      }
    } finally {
      activeRequest = false;
      setLoading(false);
      scheduleNextRefresh();
      updateCountdown();
    }
  }
  function selectGame(placeId, doRefresh = false) {
    if (!trackedGames.some((game) => game.placeId === placeId)) return;
    currentPlaceId = placeId;
    persistTrackedGames();
    renderTrackedGames();
    const state = getTrackedRecord(placeId);
    if (state.game) {
      currentGame = state.game;
      renderGame(state.game, state.status);
      loadCurrentHistory();
    } else {
      els.results.classList.remove('hidden');
      if (els.gameName) els.gameName.textContent = 'กำลังตรวจสอบเกม…';
    }
    if (doRefresh) refreshTracked({ quiet: false });
    else if (!activeRequest) { scheduleNextRefresh(); updateCountdown(); }
    if (els.results) els.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function startMonitoring(rawPlaceId) {
    const placeId = validPlaceId(rawPlaceId);
    if (!placeId) { setMessage('กรุณาใส่ Place ID เป็นตัวเลขบวก หรือวาง URL เกม Roblox ที่ถูกต้อง', 'error'); els.placeId.focus(); return; }
    const addResult = addTrackedGame(placeId);
    if (addResult.full) {
      setMessage(`Workspace เต็มแล้ว (${MAX_TRACKED_GAMES} เกม) นำเกมที่ไม่ใช้ออกก่อน แล้วลองอีกครั้ง`, 'warning'); return;
    }
    currentPlaceId = placeId;
    persistTrackedGames();
    renderTrackedGames();
    els.placeId.value = placeId;
    selectGame(placeId, false);
    setMessage(addResult.added ? 'เพิ่มเกมใน Workspace แล้ว กำลังดึงข้อมูลล่าสุด…' : 'เลือกเกมใน Workspace แล้ว กำลังดึงข้อมูลล่าสุด…');
    refreshTracked({ quiet: false });
  }
  function setGameStatus(status) {
    if (!els.publicStatus) return;
    els.publicStatus.classList.remove('offline', 'stale', 'failed');
    let label = 'PUBLIC DATA';
    if (status === 'stale') { label = 'STALE DATA'; els.publicStatus.classList.add('stale'); }
    else if (status === 'failed') { label = 'DATA ERROR'; els.publicStatus.classList.add('failed'); }
    else if (currentGame && currentGame.isPlayable === false) { label = 'LIMITED ACCESS'; els.publicStatus.classList.add('offline'); }
    else if (currentGame && currentGame.isPlayable === true) label = 'PLAYABLE';
    els.publicStatus.replaceChildren();
    const dot = document.createElement('i');
    const text = document.createTextNode(` ${label}`);
    els.publicStatus.append(dot, text);
  }
  function renderGame(game, status = 'ok') {
    if (!game) return;
    currentGame = game;
    els.results.classList.remove('hidden');
    els.gameName.textContent = game.name || `Place ${game.placeId}`;
    els.gameCreator.textContent = game.creatorName ? `สร้างโดย ${game.creatorName}` : 'ไม่พบข้อมูลผู้สร้าง';
    els.detailPlaceId.textContent = safeText(game.placeId);
    els.universeId.textContent = safeText(game.universeId);
    els.creatorId.textContent = safeText(game.creatorId);
    els.gameStatus.textContent = game.isPlayable === false ? 'จำกัดการเข้าถึง / เล่นไม่ได้' : game.isPlayable === true ? 'เปิดให้เล่นตามข้อมูล API' : 'ไม่สามารถยืนยันได้จาก API';
    els.updatedAt.textContent = formatTime(game.checkedAt || game.updatedAt);
    els.refreshedAt.textContent = `${status === 'stale' ? 'ข้อมูลเก่า · ' : 'อัปเดต '}${formatTime(game.checkedAt || Date.now())}`;
    els.openGame.href = `https://www.roblox.com/games/${encodeURIComponent(game.placeId)}`;
    els.gameAvatarLetter.textContent = (game.name || 'R').trim().charAt(0).toUpperCase() || 'R';
    if (game.iconUrl && /^https:\/\//i.test(game.iconUrl)) {
      els.gameIcon.onload = () => { els.gameIcon.classList.remove('hidden'); els.gameAvatarLetter.classList.add('hidden'); };
      els.gameIcon.onerror = () => { els.gameIcon.classList.add('hidden'); els.gameAvatarLetter.classList.remove('hidden'); };
      if (els.gameIcon.src !== game.iconUrl) els.gameIcon.src = game.iconUrl;
    } else {
      els.gameIcon.classList.add('hidden'); els.gameAvatarLetter.classList.remove('hidden');
    }
    countUp(els.playing, game.playing);
    countUp(els.maxPlayers, game.maxPlayers);
    countUp(els.visits, game.visits);
    const playing = numberValue(game.playing);
    const maxPlayers = numberValue(game.maxPlayers);
    const percentage = playing !== null && maxPlayers !== null && maxPlayers > 0 ? Math.max(0, Math.min(100, playing / maxPlayers * 100)) : null;
    const cardCapacity = els.capacityPercent.closest('.stat-card');
    if (percentage !== null) {
      countUp(els.capacityPercent, Math.round(percentage));
      els.capacityFill.style.width = `${percentage}%`;
      els.capacityCaption.textContent = `${formatNumber(playing)} จาก ${formatNumber(maxPlayers)} ช่อง`;
      els.capacityRatio.textContent = `${formatNumber(playing)} / ${formatNumber(maxPlayers)}`;
      els.ringLabel.textContent = `${Math.round(percentage)}%`;
      els.capacityRingFill.style.strokeDashoffset = String(257.6 * (1 - percentage / 100));
      els.capacityRingFill.style.stroke = percentage >= 90 ? 'var(--amber)' : 'var(--mint)';
      $$('#capacitySegments i').forEach((segment, index) => {
        const filled = index < Math.round(percentage / 5);
        segment.classList.toggle('filled', filled && percentage < 90);
        segment.classList.toggle('warn', filled && percentage >= 90);
      });
      els.capacityNote.textContent = percentage >= 90 ? 'ความจุต่อเซิร์ฟเวอร์ใกล้เต็มที่ 90% ขึ้นไป ควรตรวจสอบจำนวนผู้เล่นและการแบ่งเซิร์ฟเวอร์' : 'ค่าความจุนี้เป็นจำนวนผู้เล่นสูงสุดต่อเซิร์ฟเวอร์ ไม่ใช่จำนวนผู้เล่นรวมทั้งเกม';
      if (cardCapacity) cardCapacity.classList.toggle('warning', percentage >= 90);
    } else {
      countUp(els.capacityPercent, null);
      els.capacityFill.style.width = '0%'; els.capacityCaption.textContent = 'API ไม่ได้ส่งข้อมูลความจุ'; els.capacityRatio.textContent = '— / —'; els.ringLabel.textContent = '—';
      els.capacityRingFill.style.strokeDashoffset = '257.6';
      $$('#capacitySegments i').forEach((segment) => segment.classList.remove('filled', 'warn'));
      els.capacityNote.textContent = 'ไม่สามารถคำนวณความจุได้ เนื่องจากไม่มีค่า maxPlayers ที่ใช้ได้';
      if (cardCapacity) cardCapacity.classList.remove('warning');
    }
    setGameStatus(status);
    if (els.playerPulse) els.playerPulse.style.opacity = status === 'ok' ? '1' : '.35';
    saveRecentGame(game);
  }
  async function loadCurrentHistory() {
    if (!currentPlaceId) return;
    const placeIdAtRequest = currentPlaceId;
    const range = els.rangeSelector.value || '24h';
    let history = [];
    let source = 'Local fallback';
    try {
      const response = await requestJson(`/api/history?placeId=${encodeURIComponent(placeIdAtRequest)}&range=${encodeURIComponent(range)}`, 9000);
      if (Array.isArray(response.samples)) history = response.samples.map((sample) => ({ ts: Number(sample.ts), playing: numberValue(sample.playing), maxPlayers: numberValue(sample.maxPlayers), visits: numberValue(sample.visits), sampleCount: sample.sampleCount || 1 })).filter((sample) => Number.isFinite(sample.ts) && sample.playing !== null).sort((a, b) => a.ts - b.ts);
      source = response.source === 'd1' ? 'Cloudflare D1 · durable history' : 'Local browser fallback';
    } catch (_) {
      source = 'Local browser fallback · API history unavailable';
    }
    if (currentPlaceId !== placeIdAtRequest || (els.rangeSelector.value || '24h') !== range) return;
    if (!history.length) {
      const cutoff = Date.now() - (HISTORY_RANGE_MS[range] || HISTORY_RANGE_MS['24h']);
      history = readLocalHistory(placeIdAtRequest).filter((point) => point.ts >= cutoff);
      if (history.length) source = 'Local browser fallback';
    }
    // Keep local samples as a fallback, but avoid mixing fine-grained local points into D1's time buckets.
    if (source !== 'Cloudflare D1 · durable history') {
      const local = readLocalHistory(placeIdAtRequest).filter((point) => point.ts >= Date.now() - (HISTORY_RANGE_MS[range] || HISTORY_RANGE_MS['24h']));
      if (!history.length) history = local;
    }
    currentHistory = history;
    currentHistorySource = source;
    renderHistory(history, source);
  }
  function renderHistory(history, source) {
    history = Array.isArray(history) ? history : [];
    const valid = history.filter((p) => Number.isFinite(p.ts) && numberValue(p.playing) !== null).sort((a, b) => a.ts - b.ts);
    els.chartSamples.innerHTML = `${formatNumber(valid.length)} <small>จุด</small>`;
    els.chartDataSource.textContent = `แหล่งข้อมูล: ${source || currentHistorySource}`;
    if (!valid.length) {
      els.chartCurrent.textContent = '—'; els.chartDelta.textContent = 'ยังไม่มีข้อมูล'; els.chartDelta.className = 'chart-delta';
      els.chartStart.textContent = 'เริ่มตรวจสอบ'; els.chartEnd.textContent = 'ล่าสุด'; els.insightPeak.textContent = '—'; els.insightAverage.textContent = '—'; els.insightChange.textContent = '—';
      els.trendChart.innerHTML = '<div class="chart-empty"><span class="chart-empty-icon">⌁</span><b>ยังไม่มีประวัติในช่วงเวลานี้</b><span>ข้อมูลจะเพิ่มหลังจากระบบตรวจสอบเกมสำเร็จ</span></div>';
      renderRecentChecks(valid);
      return;
    }
    const first = valid[0], last = valid[valid.length - 1];
    els.chartCurrent.textContent = formatNumber(last.playing);
    els.chartStart.textContent = formatTime(first.ts, false);
    els.chartEnd.textContent = formatTime(last.ts, false);
    const delta = last.playing - first.playing;
    const percent = first.playing > 0 ? (delta / first.playing) * 100 : (delta > 0 ? 100 : 0);
    els.chartDelta.textContent = `${delta > 0 ? '+' : ''}${formatNumber(delta)} (${percent > 0 ? '+' : ''}${percent.toFixed(1)}%) ในช่วงนี้`;
    els.chartDelta.className = `chart-delta ${delta > 0 ? 'positive' : delta < 0 ? 'negative' : ''}`;
    const values = valid.map((p) => p.playing);
    els.insightPeak.textContent = formatNumber(Math.max(...values));
    els.insightAverage.textContent = formatNumber(values.reduce((sum, value) => sum + value, 0) / values.length);
    els.insightChange.textContent = `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`;
    els.insightChange.style.color = delta > 0 ? 'var(--mint)' : delta < 0 ? 'var(--amber)' : 'var(--text-soft)';
    renderRecentChecks(valid);
    if (valid.length < 2) {
      els.trendChart.innerHTML = '<div class="chart-empty"><span class="chart-empty-icon">⌁</span><b>เก็บข้อมูลแล้ว 1 จุด</b><span>รอการตรวจสอบครั้งถัดไปเพื่อสร้างเส้นแนวโน้ม</span></div>';
      return;
    }
    // Limit SVG vertices so 30-day histories remain responsive on low-end devices.
    const plotted = downsample(valid, 320);
    const width = 760, height = 170, pad = { top: 12, right: 9, bottom: 13, left: 9 };
    const vals = plotted.map((p) => p.playing);
    const min = Math.min(...vals), max = Math.max(...vals), span = Math.max(1, max - min);
    const domainMin = Math.max(0, min - span * .18);
    const domainMax = max + span * .18 || 1;
    const innerW = width - pad.left - pad.right, innerH = height - pad.top - pad.bottom;
    const pointAt = (value, index) => ({ x: pad.left + index * innerW / (plotted.length - 1), y: pad.top + innerH - ((value - domainMin) / Math.max(1, domainMax - domainMin)) * innerH });
    const points = plotted.map((p, index) => pointAt(p.playing, index));
    const linePath = points.map((p, index) => `${index ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
    const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(2)},${(pad.top + innerH).toFixed(2)} L${points[0].x.toFixed(2)},${(pad.top + innerH).toFixed(2)} Z`;
    const grid = [0, .33, .66, 1].map((fraction) => {
      const y = pad.top + innerH * fraction;
      return `<line x1="${pad.left}" y1="${y.toFixed(2)}" x2="${width - pad.right}" y2="${y.toFixed(2)}" stroke="#8292a2" stroke-opacity=".15" stroke-dasharray="3 6"/>`;
    }).join('');
    const lastPoint = points[points.length - 1];
    const dots = points.filter((_, index) => index === points.length - 1 || (points.length < 36 && index % 3 === 0)).map((p, index) => `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${index === points.length - 1 ? 3.7 : 2}" fill="#a5efd0" fill-opacity="${index === points.length - 1 ? 1 : .55}"/>`).join('');
    els.trendChart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="กราฟจำนวนผู้เล่นออนไลน์ย้อนหลัง"><defs><linearGradient id="playerArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#a5efd0" stop-opacity=".20"/><stop offset="100%" stop-color="#a5efd0" stop-opacity="0"/></linearGradient></defs>${grid}<path d="${areaPath}" fill="url(#playerArea)"/><path d="${linePath}" fill="none" stroke="#a5efd0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>${dots}<circle cx="${lastPoint.x.toFixed(2)}" cy="${lastPoint.y.toFixed(2)}" r="7" fill="#a5efd0" fill-opacity=".12"/></svg>`;
  }
  function downsample(points, maxPoints) {
    if (points.length <= maxPoints) return points;
    const result = [];
    const step = (points.length - 1) / (maxPoints - 1);
    for (let i = 0; i < maxPoints; i += 1) result.push(points[Math.round(i * step)]);
    return result;
  }
  function renderRecentChecks(history) {
    if (!els.recentChecks) return;
    const checks = history.slice(-5).reverse();
    els.recentChecks.replaceChildren();
    if (!checks.length) {
      const empty = document.createElement('div'); empty.className = 'activity-empty';
      const icon = document.createElement('span'); icon.className = 'activity-empty-icon'; icon.textContent = '◷';
      const title = document.createElement('strong'); title.textContent = 'ยังไม่มีประวัติ';
      const copy = document.createElement('p'); copy.textContent = 'รายการตรวจสอบจะแสดงหลังจากดึงข้อมูลสำเร็จ';
      empty.append(icon, title, copy); els.recentChecks.append(empty); return;
    }
    checks.forEach((point) => {
      const row = document.createElement('div'); row.className = 'check-row';
      const dot = document.createElement('span'); dot.className = 'check-row-dot';
      const main = document.createElement('span'); main.className = 'check-row-main';
      const title = document.createElement('strong'); title.textContent = `${formatNumber(point.playing)} ผู้เล่นออนไลน์`;
      const sub = document.createElement('span'); sub.textContent = point.maxPlayers ? `ความจุเซิร์ฟเวอร์ ${formatNumber(point.maxPlayers)}` : 'รับข้อมูลสาธารณะจาก Roblox';
      main.append(title, sub);
      const time = document.createElement('span'); time.className = 'check-row-time'; time.textContent = formatTime(point.ts);
      row.append(dot, main, time); els.recentChecks.append(row);
    });
  }
  function loadEvents() {
    const value = safeRead(STORAGE.events, []);
    return Array.isArray(value) ? value.slice(0, MAX_EVENTS) : [];
  }
  function pushEvent(type, title, detail, placeId = null, notify = true) {
    const events = loadEvents();
    const event = { id: `${Date.now()}-${Math.random().toString(16).slice(2, 7)}`, type, title, detail, placeId, ts: Date.now() };
    events.unshift(event); safeWrite(STORAGE.events, events.slice(0, MAX_EVENTS)); renderEvents();
    if (notify && notificationsEnabled && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification(`Roblox Monitor · ${title}`, { body: detail, tag: `roblox-monitor-${placeId || 'system'}` }); } catch (_) { /* Notifications can be blocked by browser policy. */ }
    }
  }
  function renderEvents() {
    if (!els.alertLog) return;
    const events = loadEvents(); els.alertLog.replaceChildren();
    if (!events.length) { const empty = document.createElement('div'); empty.className = 'alert-empty'; empty.textContent = 'ยังไม่มีเหตุการณ์ใหม่'; els.alertLog.append(empty); return; }
    events.slice(0, 8).forEach((event) => {
      const row = document.createElement('div'); row.className = `event-row ${event.type || ''}`;
      const icon = document.createElement('span'); icon.className = 'event-icon'; icon.textContent = event.type === 'error' ? '!' : event.type === 'warning' ? '△' : '✓';
      const copy = document.createElement('span'); copy.className = 'event-copy';
      const title = document.createElement('strong'); title.textContent = event.title || 'เหตุการณ์';
      const detail = document.createElement('p'); detail.textContent = event.detail || '';
      copy.append(title, detail);
      const time = document.createElement('span'); time.className = 'event-time'; time.textContent = formatTime(event.ts);
      row.append(icon, copy, time); els.alertLog.append(row);
    });
  }
  function detectAlerts(previous, next) {
    const threshold = playerThreshold;
    if (next.playing !== null && next.playing >= threshold && (!previous || numberValue(previous.playing) < threshold)) {
      pushEvent('warning', 'ผู้เล่นถึงเกณฑ์ที่ตั้งไว้', `${next.name}: ${formatNumber(next.playing)} คน (เกณฑ์ ${formatNumber(threshold)} คน)`, next.placeId, true);
    }
    const newCap = next.playing !== null && next.maxPlayers > 0 ? next.playing / next.maxPlayers * 100 : null;
    const oldCap = previous && numberValue(previous.maxPlayers) > 0 && numberValue(previous.playing) !== null ? previous.playing / previous.maxPlayers * 100 : null;
    if (newCap !== null && newCap >= 90 && (oldCap === null || oldCap < 90)) {
      pushEvent('warning', 'เซิร์ฟเวอร์ใกล้เต็ม', `${next.name}: ใช้ความจุ ${newCap.toFixed(1)}%`, next.placeId, true);
    }
  }
  async function toggleNotifications() {
    if (!('Notification' in window)) { setMessage('เบราว์เซอร์นี้ไม่รองรับ Browser Notifications ใช้ดูเหตุการณ์ในหน้าเว็บแทนได้', 'warning'); return; }
    if (notificationsEnabled) {
      notificationsEnabled = false; safeWrite(STORAGE.notifications, false); updateNotificationButton(); setMessage('ปิด Browser Notifications แล้ว เหตุการณ์ยังบันทึกในหน้าเว็บ', 'success'); return;
    }
    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();
    if (permission !== 'granted') { setMessage('ยังไม่ได้รับอนุญาตให้แจ้งเตือน ตรวจสอบสิทธิ์การแจ้งเตือนของเว็บไซต์ในเบราว์เซอร์', 'warning'); return; }
    notificationsEnabled = true; safeWrite(STORAGE.notifications, true); updateNotificationButton();
    setMessage('เปิด Browser Notifications แล้ว การแจ้งเตือนจะทำงานเมื่อหน้านี้เปิดอยู่และตรวจพบเหตุการณ์', 'success');
  }
  function updateNotificationButton() {
    if (!els.notificationsToggle) return;
    els.notificationsToggle.classList.toggle('enabled', notificationsEnabled);
    const span = $('span', els.notificationsToggle); if (span) span.textContent = notificationsEnabled ? 'ปิดแจ้งเตือน' : 'เปิดแจ้งเตือน';
  }
  function scheduleNextRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null; nextRefreshAt = null;
    if (!trackedGames.length || document.hidden) { if (els.countdown) els.countdown.textContent = document.hidden ? 'พักเมื่อซ่อนแท็บ' : 'พร้อมอัปเดต'; return; }
    nextRefreshAt = Date.now() + refreshSeconds * 1000;
    refreshTimer = setTimeout(() => refreshTracked({ quiet: true }), refreshSeconds * 1000);
    updateCountdown();
  }
  function updateCountdown() {
    if (!els.countdown) return;
    if (document.hidden) { els.countdown.textContent = 'พักเมื่อซ่อนแท็บ'; return; }
    if (!nextRefreshAt) { els.countdown.textContent = trackedGames.length ? 'พร้อมอัปเดต' : 'ยังไม่มีเกม'; return; }
    const seconds = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
    els.countdown.textContent = `อัปเดตใน ${seconds} วิ`;
  }
  function exportHistoryCsv() {
    if (!currentPlaceId || !currentHistory.length) { setMessage('ไม่มีประวัติในช่วงเวลานี้ให้ส่งออก', 'warning'); return; }
    const headers = ['timestamp_iso', 'place_id', 'game_name', 'playing', 'max_players', 'visits', 'sample_count'];
    const rows = currentHistory.map((point) => [new Date(point.ts).toISOString(), currentPlaceId, currentGame?.name || '', point.playing, point.maxPlayers ?? '', point.visits ?? '', point.sampleCount || 1]);
    const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const csv = '\ufeff' + [headers, ...rows].map((row) => row.map(escape).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = `roblox-monitor-${currentPlaceId}-${els.rangeSelector.value}.csv`;
    document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    setMessage(`ส่งออก CSV แล้ว · ${currentHistory.length} จุดข้อมูล`, 'success');
  }

  els.gameForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const placeId = parsePlaceId(els.placeId.value);
    if (!placeId) { setMessage('กรุณาใส่ Place ID เป็นตัวเลขบวก หรือวาง URL เกม Roblox ที่ถูกต้อง', 'error'); els.placeId.focus(); return; }
    startMonitoring(placeId);
  });
  els.refreshNow.addEventListener('click', () => { if (!activeRequest && trackedGames.length) { if (refreshTimer) clearTimeout(refreshTimer); refreshTracked({ quiet: false }); } });
  els.refreshInterval.addEventListener('change', () => {
    refreshSeconds = Math.max(DEFAULT_REFRESH_SECONDS, Number(els.refreshInterval.value) || DEFAULT_REFRESH_SECONDS);
    updateTrackedCount(); scheduleNextRefresh();
  });
  els.recentGames.addEventListener('click', (event) => {
    const button = event.target.closest('[data-place-id]'); if (!button) return;
    const placeId = validPlaceId(button.dataset.placeId); if (!placeId) return;
    if (!trackedGames.some((game) => game.placeId === placeId)) {
      const result = addTrackedGame(placeId);
      if (result.full) { setMessage(`Workspace เต็มแล้ว (${MAX_TRACKED_GAMES} เกม)`, 'warning'); return; }
    }
    startMonitoring(placeId);
  });
  els.trackedGrid.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-place-id]');
    if (remove) { event.stopPropagation(); removeTrackedGame(remove.dataset.removePlaceId); return; }
    const card = event.target.closest('[data-place-id]');
    if (card) selectGame(card.dataset.placeId, false);
  });
  els.trackedGrid.addEventListener('keydown', (event) => {
    const card = event.target.closest('.tracked-card');
    if (card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); selectGame(card.dataset.placeId, false); }
  });
  els.clearTracked.addEventListener('click', () => {
    if (!trackedGames.length) return;
    const ok = window.confirm('ล้างรายการเกมที่ติดตามทั้งหมดจากเบราว์เซอร์นี้หรือไม่? ประวัติ D1 ที่เก็บบนเซิร์ฟเวอร์จะไม่ถูกลบ');
    if (!ok) return;
    trackedGames = []; trackedState.clear(); currentPlaceId = null; currentGame = null; currentHistory = [];
    persistTrackedGames(); renderTrackedGames(); els.results.classList.add('hidden');
    if (refreshTimer) clearTimeout(refreshTimer); nextRefreshAt = null;
    setMessage('ล้างรายการเกมแล้ว ประวัติฝั่ง D1 ไม่ถูกลบ', 'success'); scheduleNextRefresh();
  });
  els.playerThreshold.addEventListener('change', () => {
    const value = Math.floor(Number(els.playerThreshold.value));
    if (!Number.isFinite(value) || value < 1) { els.playerThreshold.value = String(playerThreshold); return; }
    playerThreshold = Math.min(value, 100000000); els.playerThreshold.value = String(playerThreshold); safeWrite(STORAGE.threshold, playerThreshold);
    setMessage(`ตั้งเกณฑ์แจ้งเตือนผู้เล่นที่ ${formatNumber(playerThreshold)} คน`, 'success');
  });
  els.notificationsToggle.addEventListener('click', toggleNotifications);
  els.clearEvents.addEventListener('click', () => { safeWrite(STORAGE.events, []); renderEvents(); setMessage('ล้างประวัติเหตุการณ์ในเบราว์เซอร์แล้ว', 'success'); });
  els.rangeSelector.addEventListener('change', loadCurrentHistory);
  els.exportHistoryBtn.addEventListener('click', exportHistoryCsv);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (refreshTimer) clearTimeout(refreshTimer); refreshTimer = null; nextRefreshAt = null; updateCountdown(); }
    else if (trackedGames.length) refreshTracked({ quiet: true });
  });
  $$('.nav-link').forEach((link) => link.addEventListener('click', () => { $$('.nav-link').forEach((item) => item.classList.remove('active')); link.classList.add('active'); }));

  async function initialize() {
    const storedThreshold = Number(safeRead(STORAGE.threshold, DEFAULT_PLAYER_THRESHOLD));
    if (Number.isFinite(storedThreshold) && storedThreshold >= 1) playerThreshold = Math.min(Math.floor(storedThreshold), 100000000);
    els.playerThreshold.value = String(playerThreshold);
    notificationsEnabled = safeRead(STORAGE.notifications, false) === true && 'Notification' in window && Notification.permission === 'granted';
    updateNotificationButton();
    loadTrackedGamesFromStorage();
    renderTrackedGames(); renderRecentGames(); renderEvents(); updateTrackedCount();
    await checkApiHealth();
    if (trackedGames.length && currentPlaceId) {
      els.placeId.value = currentPlaceId;
      const state = getTrackedRecord(currentPlaceId);
      if (state.game) { currentGame = state.game; renderGame(state.game, 'stale'); }
      const local = readLocalHistory(currentPlaceId).filter((point) => point.ts >= Date.now() - HISTORY_RANGE_MS[els.rangeSelector.value || '24h']);
      renderHistory(local, 'Local browser fallback · awaiting server history');
      refreshTracked({ quiet: true });
    } else {
      setMessage(apiHealth.online ? 'ระบบพร้อมใช้งาน ใส่ Place ID เพื่อเริ่มติดตามเกม' : 'หน้าเว็บโหลดแล้ว แต่ยังติดต่อ API ไม่ได้ ต้องติดตั้ง Worker API ก่อนจึงจะดึงข้อมูล Live ได้', apiHealth.online ? '' : 'warning');
    }
    countdownTimer = setInterval(updateCountdown, 1000);
  }
  initialize();
})();
