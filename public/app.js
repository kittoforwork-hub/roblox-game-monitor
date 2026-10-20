const $ = (selector) => document.querySelector(selector);
const placeIdInput = $('#placeId');
const checkBtn = $('#checkBtn');
const message = $('#message');
const results = $('#results');
let refreshTimer = null;
let currentPlaceId = null;
function formatNumber(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? new Intl.NumberFormat('th-TH').format(n) : '—';
}
function formatTime(value) {
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'medium' }).format(value);
}
function showMessage(text, type = '') {
  message.textContent = text;
  message.className = `message ${type}`.trim();
}
function renderGame(game) {
  $('#gameName').textContent = game.name || 'ไม่พบชื่อเกม';
  $('#gameCreator').textContent = game.creatorName ? `สร้างโดย ${game.creatorName}` : 'ไม่พบข้อมูลผู้สร้าง';
  $('#playing').textContent = formatNumber(game.playing);
  $('#maxPlayers').textContent = formatNumber(game.maxPlayers);
  $('#visits').textContent = formatNumber(game.visits);
  $('#detailPlaceId').textContent = formatNumber(game.placeId);
  $('#universeId').textContent = formatNumber(game.universeId);
  $('#gameStatus').textContent = game.isPlayable === false ? 'ไม่พร้อมเล่น / จำกัดการเข้าถึง' : 'มีข้อมูลสาธารณะ';
  $('#updatedAt').textContent = formatTime(new Date());
  $('#refreshedAt').textContent = `อัปเดต ${new Date().toLocaleTimeString('th-TH')}`;
  $('#openGame').href = `https://www.roblox.com/games/${encodeURIComponent(game.placeId)}`;
  results.classList.remove('hidden');
}
async function loadGame(placeId, quiet = false) {
  if (!quiet) {
    checkBtn.disabled = true;
    checkBtn.querySelector('span').textContent = 'กำลังตรวจสอบ…';
    showMessage('กำลังดึงข้อมูลเกมจาก Roblox…');
  }
  try {
    const response = await fetch(`/api/game?placeId=${encodeURIComponent(placeId)}`, { headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `เรียกข้อมูลไม่สำเร็จ (${response.status})`);
    renderGame(body);
    if (!quiet) showMessage('โหลดข้อมูลเกมสำเร็จ ระบบจะตรวจสอบข้อมูลซ้ำทุก 60 วินาที', 'success');
  } catch (error) {
    if (!quiet || !results.classList.contains('hidden')) showMessage(`${error.message || 'เกิดข้อผิดพลาด'} — ตรวจสอบว่า Game ID ถูกต้องและเกมเปิดเผยต่อสาธารณะ`, 'error');
  } finally {
    if (!quiet) {
      checkBtn.disabled = false;
      checkBtn.querySelector('span').textContent = 'ตรวจสอบเกม';
    }
  }
}
function startMonitoring(placeId) {
  currentPlaceId = placeId;
  try { localStorage.setItem('robloxMonitorPlaceId', placeId); } catch (_) {}
  if (refreshTimer) clearInterval(refreshTimer);
  loadGame(placeId);
  refreshTimer = setInterval(() => { if (currentPlaceId) loadGame(currentPlaceId, true); }, 60000);
}
function submit() {
  const raw = placeIdInput.value.trim();
  const urlMatch = raw.match(/roblox\.com\/games\/(\d+)/i);
  const placeId = urlMatch ? urlMatch[1] : raw;
  if (!/^\d{1,20}$/.test(placeId) || BigInt(placeId) <= 0n) {
    showMessage('กรุณาใส่ Game ID เป็นตัวเลข หรือวาง URL เกม Roblox แบบเต็ม', 'error');
    placeIdInput.focus();
    return;
  }
  placeIdInput.value = placeId;
  startMonitoring(placeId);
}
checkBtn.addEventListener('click', submit);
placeIdInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
try {
  const saved = localStorage.getItem('robloxMonitorPlaceId');
  if (saved && /^\d+$/.test(saved)) { placeIdInput.value = saved; startMonitoring(saved); }
} catch (_) {}
