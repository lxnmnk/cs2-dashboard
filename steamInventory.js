// Публичный инвентарь CS2 клиента через Steam Community API — тот же
// эндпоинт, что открывает вкладка "Inventory" на профиле, без OAuth и
// специальных прав, но требует, чтобы у клиента инвентарь был публичным
// (иначе Steam отвечает success:0 или пустым списком).
// count выше ~2000 Steam отвечает 400 (не документировано, но проверено на
// практике), поэтому большие инвентари забираем страницами: пока Steam
// отвечает more_items, идём дальше от last_assetid. Без этого у человека с
// тысячами кейсов дорогие предметы могли просто не попасть в ответ.
const PAGE_SIZE = 2000;
const MAX_PAGES = 6; // ~12 тысяч предметов: дальше это уже не клиент, а склад
const INVENTORY_URL = (steamId, startAssetId) =>
  `https://steamcommunity.com/inventory/${steamId}/730/2?l=english&count=${PAGE_SIZE}` +
  (startAssetId ? `&start_assetid=${startAssetId}` : "");

// Steam лимитирует запросы по IP, а IP у нас один на всех клиентов сайта:
// без кэша каждое открытие кабинета (и каждый повтор после ошибки) бьёт по
// общему лимиту, и хватает одного 429, чтобы страница легла у всех сразу.
// Свежий снимок отдаём из памяти, а при ошибке — последний удачный, даже
// протухший: показать инвентарь минутной давности лучше, чем пустоту.
const CACHE_TTL_MS = 60 * 1000;
const MAX_CACHED_USERS = 200;
const inventoryCache = new Map(); // steamId -> { items, at }

function rememberInventory(steamId, items) {
  if (inventoryCache.size >= MAX_CACHED_USERS && !inventoryCache.has(steamId)) {
    inventoryCache.delete(inventoryCache.keys().next().value); // Map хранит порядок вставки — выкидываем самый старый
  }
  inventoryCache.set(steamId, { items, at: Date.now() });
}

// Предмет в трейд-бане Steam отдаёт как tradable:0, но с пометкой вида
// "Tradable After Sep 14, 2026 (07:00:00)" в owner_descriptions. По ней их
// можно отличить от вещей, которые не торгуются никогда (медали, монеты,
// граффити) — первые нужно показывать клиенту, вторые нет.
function tradableAfterOf(desc) {
  const note = (desc.owner_descriptions || []).find((o) => /tradable after/i.test(o?.value || ""));
  return note ? note.value.replace(/\s+/g, " ").trim() : null;
}

// Список сформирован из уникальных пар classid+instanceid — один и тот же
// предмет (например 3 одинаковых ножа) описан в descriptions один раз, а
// в assets повторяется трижды с разными assetid.
async function fetchInventory(steamId, { force = false } = {}) {
  const cached = inventoryCache.get(steamId);
  // force — клиент сам нажал "обновить": кэш в этом случае игнорируем, иначе
  // только что полученный предмет не появился бы ещё минуту.
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.items;

  const items = [];
  let startAssetId = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    let resp;
    try {
      resp = await fetch(INVENTORY_URL(steamId, startAssetId), {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; gaben-market-bot/1.0)" },
      });
    } catch (err) {
      if (cached) return cached.items;
      throw err;
    }

    // Приватность — это ответ про самого клиента, тут подставлять старый снимок
    // нельзя: человек мог закрыть инвентарь намеренно.
    if (resp.status === 403) throw new Error("PRIVATE_INVENTORY");
    if (!resp.ok) {
      if (cached) return cached.items;
      // 429 прилетает по IP сервера и общий для всех клиентов — это НЕ приватный
      // инвентарь, и советовать человеку менять настройки приватности тут нельзя.
      if (resp.status === 429) throw new Error("STEAM_RATE_LIMITED");
      throw new Error(`Steam ответил ${resp.status}`);
    }

    const data = await resp.json().catch(() => null);
    if (!data || data.success !== 1 || !Array.isArray(data.assets)) {
      // Под нагрузкой Steam отдаёт 200 с success:0 — приватность тут ни при чём,
      // так что прошлый снимок (если есть) честнее, чем совет открыть инвентарь.
      if (cached) return cached.items;
      throw new Error("PRIVATE_INVENTORY");
    }

    const descByKey = new Map();
    for (const d of data.descriptions || []) {
      descByKey.set(`${d.classid}_${d.instanceid || 0}`, d);
    }

    for (const a of data.assets) {
      const desc = descByKey.get(`${a.classid}_${a.instanceid || 0}`);
      if (!desc || !desc.market_hash_name) continue;
      items.push({
        assetId: a.assetid,
        marketHashName: desc.market_hash_name,
        tradable: !!desc.tradable,
        tradableAfter: desc.tradable ? null : tradableAfterOf(desc),
        icon: desc.icon_url ? `https://community.akamai.steamstatic.com/economy/image/${desc.icon_url}/512fx384f` : null,
      });
    }

    if (!data.more_items || !data.last_assetid) break;
    startAssetId = data.last_assetid;
  }

  rememberInventory(steamId, items);
  return items;
}

module.exports = { fetchInventory };
