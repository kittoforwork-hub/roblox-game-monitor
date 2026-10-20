const $ = (selector) => document.querySelector(selector);
const placeIdInput = $('#placeId');
const gameForm = $('#gameForm');
const checkBtn = $('#checkBtn');
const message = $('#message');
const messageText = $('.message-text');
const results = $('#results');
const refreshNowBtn = $('#refreshNow');
const refreshIntervalInput = $('#refreshInterval');

const DEFAULT_REFRESH_SECONDS = 60;
const MAX_SAMPLES = 24;
const MAX_RECENT_GAMES = 4;
let refreshTimer = null;
let countdownTimer = null;
let activeRequest = false;
let currentPlaceId = null;
let refreshSeconds = DEFAULT_REFRESH_SECONDS;
let nextRefreshAt = null;
let requestStartedAt = 0;

function formatNumber(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? new Intl.NumberFormat('th-TH').format(n) : '—';
}
function formatTime(value, seconds = true) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('th-TH', seconds
    ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}
function showMessage(text, type = '') {
  messageText.textContent = text;
  message.className = `message ${type}`.trim();
}
function countUp(element, target) {
  if (!Number.isFinite(Number(target))) {
    element.textContent = '—';
    return;
  }
  const end = Number(target);
  const start = Number(element.dataset.value || 0);
  element.dataset.value = String(end);
  if (start === end || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    element.textContent = formatNumber(end);
    return;
  }
  const duration = 620;
  const startAt = performance.now();
  element.classList.remove('number-pop');
  void element.offsetWidth;
  element.classList.add('number-pop');
  function animate(now) {
    const progress = Math.min(1, (now - startAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = Math.round(start + (end - start) * eased);
    element.textContent = formatNumber(value);
    if (progress < 1) requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
}
function historyKey(placeId) { return `robloxMonitorHistory:${placeId}`; }
function recentKey() { return 'robloxMonitorRecentGames'; }
function readHistory(placeId) {
  try {
    const stored = JSON.parse(localStorage.getItem(historyKey(placeId)) || '[]');
    if (!Array.isArray(stored)) return [];
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return stored.filter((point) => point && Number.isFinite(point.ts) && point.ts >= cutoff && Number.isFinite(point.playing));
  } catch (_) { return []; }
}
function saveSnapshot(game) {
  const points = readHistory(game.placeId);
  points.push({ ts: Date.now(), playing: Number(game.playing) || 0, maxPlayers: Number(game.maxPlayers) || null });
  try { localStorage.setItem(historyKey(game.placeId), JSON.stringify(points.slice(-MAX_SAMPLES))); } catch (_) {}
  renderHistory(game.placeId);
  renderRecentChecks(game.placeId);
}
function readRecentGames() {
  try {
    const games = JSON.parse(localStorage.getItem(recentKey()) || '[]');
    return Array.isArray(games) ? games.slice(0, MAX_RECENT_GAMES) : [];
  } catch (_) { return []; }
}
function saveRecentGame(game) {
  const games = readRecentGames().filter((item) => String(item.placeId) !== String(game.placeId));
  games.unshift({ placeId: String(game.placeId), name: game.name || `เกม ${game.placeId}` });
  try { localStorage.setItem(recentKey(), JSON.stringify(games.slice(0, MAX_RECENT_GAMES))); } catch (_) {}
  renderRecentGames();
}
function renderRecentGames() {
  const container = $('#recentGames');
  const games = readRecentGames();
  container.replaceChildren();
  if (!games.length) { container.classList.add('hidden'); return; }
  container.classList.remove('hidden');
  const label = document.createElement('span');
  label.className = 'recent-games-label';
  label.textContent = 'RECENT';
  container.append(label);
  games.forEach((game) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent-game-chip';
    button.dataset.placeId = String(game.placeId);
    const name = document.createElement('span');
    name.textContent = game.name || `เกม ${game.placeId}`;
    button.append(name);
    container.append(button);
  });
}
function renderGame(game) {
  $('#gameName').textContent = game.name || 'ไม่พบชื่อเกม';
  $('#gameCreator').textContent = game.creatorName ? `สร้างโดย ${game.creatorName}` : 'ไม่พบข้อมูลผู้สร้าง';
  $('#detailPlaceId').textContent = formatNumber(game.placeId);
  $('#universeId').textContent = formatNumber(game.universeId);
  $('#creatorId').textContent = game.creatorId ? formatNumber(game.creatorId) : 'ไม่ระบุ';
  $('#gameStatus').textContent = game.isPlayable === false ? 'ไม่พร้อมเล่น / จำกัดการเข้าถึง' : 'เปิดเผยข้อมูลสาธารณะ';
  $('#updatedAt').textContent = formatTime(new Date());
  $('#refreshedAt').textContent = `อัปเดต ${formatTime(new Date())}`;
  $('#openGame').href = `https://www.roblox.com/games/${encodeURIComponent(game.placeId)}`;
  $('#gameAvatarLetter').textContent = (game.name || 'R').trim().charAt(0).toUpperCase() || 'R';
  const gameIcon = $('#gameIcon');
  if (game.iconUrl) {
    gameIcon.onload = () => { gameIcon.classList.remove('hidden'); $('#gameAvatarLetter').classList.add('hidden'); };
    gameIcon.onerror = () => { gameIcon.classList.add('hidden'); $('#gameAvatarLetter').classList.remove('hidden'); };
    gameIcon.src = game.iconUrl;
  } else {
    gameIcon.classList.add('hidden');
    $('#gameAvatarLetter').classList.remove('hidden');
  }
  countUp($('#playing'), game.playing);
  countUp($('#maxPlayers'), game.maxPlayers);
  countUp($('#visits'), game.visits);
  const playing = Number(game.playing);
  const maxPlayers = Number(game.maxPlayers);
  const hasCapacity = Number.isFinite(playing) && Number.isFinite(maxPlayers) && maxPlayers > 0;
  const percentage = hasCapacity ? Math.min(100, Math.max(0, (playing / maxPlayers) * 100)) : null;
  if (percentage !== null) {
    countUp($('#capacityPercent'), Math.round(percentage));
    $('#capacityFill').style.width = `${percentage}%`;
    $('#capacityCaption').textContent = `${formatNumber(playing)} จาก ${formatNumber(maxPlayers)} ช่อง`;
    $('#capacityRatio').textContent = `${formatNumber(playing)} / ${formatNumber(maxPlayers)}`;
    $('#ringLabel').textContent = `${Math.round(percentage)}%`;
    $('#capacityRingFill').style.strokeDashoffset = String(257.6 * (1 - percentage / 100));
    $('#capacityRingFill').style.stroke = percentage >= 90 ? '#ffc879' : '#72f6bd';
    Array.from($('#capacitySegments').children).forEach((segment, index) => {
      const filled = index < Math.round(percentage / 5);
      segment.classList.toggle('filled', filled && percentage < 90);
      segment.classList.toggle('warn', filled && percentage >= 90);
    });
    $('#capacityNote').textContent = percentage >= 90
      ? 'เซิร์ฟเวอร์ใกล้เต็มเมื่อเทียบกับค่าความจุสูงสุดต่อเซิร์ฟเวอร์'
      : 'ข้อมูลนี้เป็นค่าความจุต่อเซิร์ฟเวอร์ ไม่ใช่จำนวนผู้เล่นทั้งเกม';
  } else {
    countUp($('#capacityPercent'), NaN);
    $('#capacityFill').style.width = '0%';
    $('#capacityCaption').textContent = 'Roblox ไม่ส่งข้อมูลความจุ';
    $('#capacityRatio').textContent = '— / —';
    $('#ringLabel').textContent = '—';
    $('#capacityRingFill').style.strokeDashoffset = '257.6';
    Array.from($('#capacitySegments').children).forEach((segment) => segment.classList.remove('filled', 'warn'));
  }
  const publicStatus = $('#publicStatus');
  publicStatus.classList.toggle('offline', game.isPlayable === false);
  publicStatus.innerHTML = game.isPlayable === false ? '<i></i> LIMITED ACCESS' : '<i></i> PUBLIC STATUS';
  results.classList.remove('hidden');
  saveRecentGame(game);
}
function renderHistory(placeId) {
  const history = readHistory(placeId);
  $('#chartSamples').innerHTML = `${history.length} <small>checks</small>`;
  if (!history.length) {
    $('#chartCurrent').textContent = '—';
    $('#chartDelta').textContent = 'รอข้อมูลเพิ่ม';
    $('#chartDelta').className = 'chart-delta';
    $('#chartStart').textContent = 'เริ่มตรวจสอบ';
    $('#chartEnd').textContent = 'ล่าสุด';
    $('#trendChart').innerHTML = '<div class="chart-empty"><span class="chart-empty-icon">⌁</span><b>กำลังรอข้อมูล</b><span>กราฟจะแสดงหลังตรวจสอบเกมอย่างน้อย 2 ครั้ง</span></div>';
    return;
  }
  const first = history[0];
  const last = history[history.length - 1];
  $('#chartCurrent').textContent = formatNumber(last.playing);
  $('#chartStart').textContent = formatTime(first.ts, false);
  $('#chartEnd').textContent = formatTime(last.ts, false);
  if (history.length > 1) {
    const delta = last.playing - history[history.length - 2].playing;
    $('#chartDelta').textContent = `${delta > 0 ? '+' : ''}${formatNumber(delta)} จากครั้งก่อน`;
    $('#chartDelta').className = `chart-delta ${delta > 0 ? 'positive' : delta < 0 ? 'negative' : ''}`;
  } else {
    $('#chartDelta').textContent = 'รอข้อมูลเพิ่ม';
    $('#chartDelta').className = 'chart-delta';
  }
  if (history.length < 2) {
    $('#trendChart').innerHTML = '<div class="chart-empty"><span class="chart-empty-icon">⌁</span><b>เก็บข้อมูลแล้ว 1 จุด</b><span>รอการตรวจสอบครั้งถัดไปเพื่อสร้างแนวโน้ม</span></div>';
    return;
  }
  const width = 700, height = 175, pad = { top: 15, right: 8, bottom: 16, left: 8 };
  const values = history.map((p) => p.playing);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const span = Math.max(1, maxValue - minValue);
  const domainMin = Math.max(0, minValue - span * .25);
  const domainMax = maxValue + span * .25 || 1;
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const pointAt = (value, index) => ({
    x: pad.left + (history.length === 1 ? innerW / 2 : index * innerW / (history.length - 1)),
    y: pad.top + innerH - ((value - domainMin) / Math.max(1, domainMax - domainMin)) * innerH
  });
  const points = history.map((p, index) => pointAt(p.playing, index));
  const linePath = points.map((p, index) => `${index ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(2)},${(pad.top + innerH).toFixed(2)} L${points[0].x.toFixed(2)},${(pad.top + innerH).toFixed(2)} Z`;
  const grid = [0, .33, .66, 1].map((fraction) => {
    const y = pad.top + innerH * fraction;
    return `<line x1="${pad.left}" y1="${y.toFixed(2)}" x2="${width - pad.right}" y2="${y.toFixed(2)}" stroke="#8097ad" stroke-opacity=".13" stroke-dasharray="3 6"/>`;
  }).join('');
  const dots = points.map((p, index) => `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${index === points.length - 1 ? 4 : 2.2}" fill="${index === points.length - 1 ? '#72f6bd' : '#9cebd0'}" fill-opacity="${index === points.length - 1 ? 1 : .55}"/>`).join('');
  $('#trendChart').innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="กราฟแนวโน้มจำนวนผู้เล่นออนไลน์"><defs><linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#72f6bd" stop-opacity=".23"/><stop offset="100%" stop-color="#72f6bd" stop-opacity="0"/></linearGradient></defs>${grid}<path d="${areaPath}" fill="url(#trendFill)"/><path d="${linePath}" fill="none" stroke="#72f6bd" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>${dots}<circle cx="${points[points.length - 1].x.toFixed(2)}" cy="${points[points.length - 1].y.toFixed(2)}" r="8" fill="#72f6bd" fill-opacity=".1"/></svg>`;
}
function renderRecentChecks(placeId) {
  const history = readHistory(placeId).slice(-5).reverse();
  const container = $('#recentChecks');
  container.replaceChildren();
  if (!history.length) {
    const empty = document.createElement('div');
    empty.className = 'activity-empty';
    empty.innerHTML = '<span>◷</span><p>เมื่อมีการตรวจสอบข้อมูล รายการจะปรากฏตรงนี้</p>';
    container.append(empty);
    return;
  }
  history.forEach((point, index) => {
    const row = document.createElement('div');
    row.className = 'check-row';
    row.style.animationDelay = `${index * 45}ms`;
    const dot = document.createElement('span');
    dot.className = 'check-row-dot';
    const main = document.createElement('span');
    main.className = 'check-row-main';
    const title = document.createElement('strong');
    title.textContent = `${formatNumber(point.playing)} ผู้เล่นออนไลน์`;
    const subtitle = document.createElement('span');
    subtitle.textContent = 'รับข้อมูลสาธารณะจาก Roblox';
    main.append(title, subtitle);
    const time = document.createElement('span');
    time.className = 'check-row-time';
    time.textContent = formatTime(point.ts);
    row.append(dot, main, time);
    container.append(row);
  });
}
function setLoading(loading) {
  checkBtn.disabled = loading;
  checkBtn.classList.toggle('loading', loading);
  checkBtn.querySelector('.button-label').textContent = loading ? 'กำลังตรวจสอบ…' : 'ตรวจสอบเกม';
  if (loading) refreshNowBtn.classList.add('spinning');
  else refreshNowBtn.classList.remove('spinning');
}
function updateCountdown() {
  const countdown = $('#countdown');
  if (!currentPlaceId || !nextRefreshAt) {
    countdown.textContent = 'พร้อมอัปเดต';
    return;
  }
  const remaining = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
  countdown.textContent = `อัปเดตใน ${remaining} วิ`;
}
function scheduleNextRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (!currentPlaceId) return;
  nextRefreshAt = Date.now() + refreshSeconds * 1000;
  updateCountdown();
  refreshTimer = setTimeout(() => {
    if (currentPlaceId) loadGame(currentPlaceId, true);
  }, refreshSeconds * 1000);
}
async function loadGame(placeId, quiet = false) {
  if (activeRequest) return;
  activeRequest = true;
  requestStartedAt = Date.now();
  if (!quiet) {
    setLoading(true);
    showMessage('กำลังเชื่อมต่อ Roblox API และดึงข้อมูลเกม…');
  }
  try {
    const response = await fetch(`/api/game?placeId=${encodeURIComponent(placeId)}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `เรียกข้อมูลไม่สำเร็จ (${response.status})`);
    renderGame(body);
    saveSnapshot(body);
    const elapsed = Math.max(1, Math.round((Date.now() - requestStartedAt) / 100) / 10);
    if (!quiet) showMessage(`เชื่อมต่อสำเร็จ · รับข้อมูลภายใน ${elapsed} วินาที ระบบกำลังตรวจสอบซ้ำอัตโนมัติ`, 'success');
    else showMessage(`ข้อมูลอัปเดตแล้ว · ${formatTime(new Date())}`, 'success');
  } catch (error) {
    showMessage(`${error.message || 'เกิดข้อผิดพลาด'} — ตรวจสอบว่า Place ID ถูกต้องและเกมเปิดเผยต่อสาธารณะ`, 'error');
  } finally {
    activeRequest = false;
    setLoading(false);
    if (currentPlaceId === String(placeId)) scheduleNextRefresh();
  }
}
function startMonitoring(placeId) {
  currentPlaceId = String(placeId);
  try { localStorage.setItem('robloxMonitorPlaceId', currentPlaceId); } catch (_) {}
  if (refreshTimer) clearTimeout(refreshTimer);
  loadGame(currentPlaceId);
}
function submit(event) {
  if (event) event.preventDefault();
  const raw = placeIdInput.value.trim();
  const urlMatch = raw.match(/roblox\.com\/games\/(\d+)/i);
  const placeId = urlMatch ? urlMatch[1] : raw;
  if (!/^\d{1,20}$/.test(placeId) || BigInt(placeId) <= 0n) {
    showMessage('กรุณาใส่ Place ID เป็นตัวเลข หรือวาง URL เกม Roblox แบบเต็ม', 'error');
    placeIdInput.focus();
    return;
  }
  placeIdInput.value = placeId;
  startMonitoring(placeId);
}
gameForm.addEventListener('submit', submit);
placeIdInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(event); });
refreshNowBtn.addEventListener('click', () => {
  if (currentPlaceId && !activeRequest) {
    if (refreshTimer) clearTimeout(refreshTimer);
    loadGame(currentPlaceId, false);
    refreshNowBtn.classList.add('spinning');
  }
});
refreshIntervalInput.addEventListener('change', () => {
  refreshSeconds = Math.max(60, Number(refreshIntervalInput.value) || DEFAULT_REFRESH_SECONDS);
  if (currentPlaceId && !activeRequest) scheduleNextRefresh();
});
$('#recentGames').addEventListener('click', (event) => {
  const button = event.target.closest('[data-place-id]');
  if (!button) return;
  placeIdInput.value = button.dataset.placeId;
  startMonitoring(button.dataset.placeId);
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
countdownTimer = setInterval(updateCountdown, 1000);
renderRecentGames();
try {
  const saved = localStorage.getItem('robloxMonitorPlaceId');
  if (saved && /^\d{1,20}$/.test(saved)) {
    placeIdInput.value = saved;
    currentPlaceId = saved;
    renderHistory(saved);
    renderRecentChecks(saved);
    startMonitoring(saved);
  }
} catch (_) {}
