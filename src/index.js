function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });
}

async function handleGame(request) {
  const requestUrl = new URL(request.url);
  const placeId = requestUrl.searchParams.get('placeId') || '';
  if (!/^\d{1,20}$/.test(placeId) || BigInt(placeId) <= 0n) {
    return json({ error: 'Game ID ไม่ถูกต้อง กรุณาใส่ Place ID ที่เป็นตัวเลข' }, 400);
  }
  try {
    const universeResponse = await fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`, {
      headers: { accept: 'application/json', 'user-agent': 'RobloxGameMonitorStarter/1.0' }
    });
    if (universeResponse.status === 404) return json({ error: 'ไม่พบ Game ID นี้ หรือเกมไม่เปิดเผยต่อสาธารณะ' }, 404);
    if (!universeResponse.ok) return json({ error: `Roblox ตอบกลับผิดปกติ (Universe lookup: ${universeResponse.status})` }, 502);
    const universeData = await universeResponse.json();
    const universeId = universeData.universeId;
    if (!universeId) return json({ error: 'Roblox ไม่ได้ส่ง Universe ID กลับมา โปรดตรวจสอบ Place ID' }, 404);
    const gameResponse = await fetch(`https://games.roblox.com/v1/games?universeIds=${encodeURIComponent(universeId)}`, {
      headers: { accept: 'application/json', 'user-agent': 'RobloxGameMonitorStarter/1.0' }
    });
    if (!gameResponse.ok) return json({ error: `ดึงข้อมูลเกมไม่สำเร็จ (Game details: ${gameResponse.status})` }, 502);
    const gameData = await gameResponse.json();
    const game = Array.isArray(gameData.data) ? gameData.data[0] : null;
    if (!game) return json({ error: 'ไม่พบรายละเอียดเกมจาก Roblox' }, 404);
    let iconUrl = null;
    try {
      const iconResponse = await fetch(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${encodeURIComponent(universeId)}&size=150x150&format=Png&isCircular=false`, {
        headers: { accept: 'application/json' }
      });
      if (iconResponse.ok) {
        const iconData = await iconResponse.json();
        iconUrl = Array.isArray(iconData.data) ? (iconData.data[0]?.imageUrl || null) : null;
      }
    } catch (_) {
      // Game icon is optional; public stats should still be returned if thumbnail lookup fails.
    }
    return json({
      placeId,
      universeId: String(universeId),
      iconUrl,
      name: game.name || null,
      description: game.description || null,
      creatorName: game.creator?.name || null,
      creatorId: game.creator?.id ? String(game.creator.id) : null,
      playing: Number.isFinite(game.playing) ? game.playing : null,
      maxPlayers: Number.isFinite(game.maxPlayers) ? game.maxPlayers : null,
      visits: Number.isFinite(game.visits) ? game.visits : null,
      isPlayable: game.isPlayable !== false,
      updated: new Date().toISOString()
    });
  } catch (error) {
    return json({ error: 'เชื่อมต่อ Roblox API ไม่สำเร็จ กรุณาลองใหม่ภายหลัง' }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/game') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      return handleGame(request);
    }
    return env.ASSETS.fetch(request);
  }
};
