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

export async function onRequestGet({ request }) {
  const requestUrl = new URL(request.url);
  const placeId = requestUrl.searchParams.get('placeId') || '';
  if (!/^\d{1,20}$/.test(placeId) || BigInt(placeId) <= 0n) {
    return json({ error: 'Game ID ไม่ถูกต้อง กรุณาใส่ Place ID ที่เป็นตัวเลข' }, 400);
  }

  try {
    // Public Roblox endpoint: resolve the submitted Place ID into its Universe ID.
    const universeResponse = await fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`, {
      headers: { 'accept': 'application/json', 'user-agent': 'RobloxGameMonitorStarter/1.0' }
    });
    if (universeResponse.status === 404) return json({ error: 'ไม่พบ Game ID นี้ หรือเกมไม่เปิดเผยต่อสาธารณะ' }, 404);
    if (!universeResponse.ok) return json({ error: `Roblox ตอบกลับผิดปกติ (Universe lookup: ${universeResponse.status})` }, 502);
    const universeData = await universeResponse.json();
    const universeId = universeData.universeId;
    if (!universeId) return json({ error: 'Roblox ไม่ได้ส่ง Universe ID กลับมา โปรดตรวจสอบ Place ID' }, 404);

    const gameResponse = await fetch(`https://games.roblox.com/v1/games?universeIds=${encodeURIComponent(universeId)}`, {
      headers: { 'accept': 'application/json', 'user-agent': 'RobloxGameMonitorStarter/1.0' }
    });
    if (!gameResponse.ok) return json({ error: `ดึงข้อมูลเกมไม่สำเร็จ (Game details: ${gameResponse.status})` }, 502);
    const gameData = await gameResponse.json();
    const game = Array.isArray(gameData.data) ? gameData.data[0] : null;
    if (!game) return json({ error: 'ไม่พบรายละเอียดเกมจาก Roblox' }, 404);

    return json({
      placeId,
      universeId: String(universeId),
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
