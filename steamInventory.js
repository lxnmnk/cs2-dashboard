// Публичный инвентарь CS2 клиента через Steam Community API — тот же
// эндпоинт, что открывает вкладка "Inventory" на профиле, без OAuth и
// специальных прав, но требует, чтобы у клиента инвентарь был публичным
// (иначе Steam отвечает success:0 или пустым списком).
// count выше ~2000 Steam отвечает 400 (не документировано, но проверено на
// практике) — пагинацию (start_assetid) не делаем, для реальных инвентарей
// этого более чем достаточно.
const INVENTORY_URL = (steamId) =>
  `https://steamcommunity.com/inventory/${steamId}/730/2?l=english&count=2000`;

// Список сформирован из уникальных пар classid+instanceid — один и тот же
// предмет (например 3 одинаковых ножа) описан в descriptions один раз, а
// в assets повторяется трижды с разными assetid.
async function fetchInventory(steamId) {
  const resp = await fetch(INVENTORY_URL(steamId), {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; gaben-market-bot/1.0)" },
  });

  if (resp.status === 403) throw new Error("PRIVATE_INVENTORY");
  if (!resp.ok) throw new Error(`Steam ответил ${resp.status}`);

  const data = await resp.json();
  if (!data || data.success !== 1 || !Array.isArray(data.assets)) {
    throw new Error("PRIVATE_INVENTORY");
  }

  const descByKey = new Map();
  for (const d of data.descriptions || []) {
    descByKey.set(`${d.classid}_${d.instanceid || 0}`, d);
  }

  const items = [];
  for (const a of data.assets) {
    const desc = descByKey.get(`${a.classid}_${a.instanceid || 0}`);
    if (!desc || !desc.market_hash_name) continue;
    items.push({
      assetId: a.assetid,
      marketHashName: desc.market_hash_name,
      tradable: !!desc.tradable,
      icon: desc.icon_url ? `https://community.akamai.steamstatic.com/economy/image/${desc.icon_url}/96fx96f` : null,
    });
  }
  return items;
}

module.exports = { fetchInventory };
