// Инвентарь клиента глазами Skinbux (GET /v1/inventory/user).
//
// Зачем не Steam: публичный инвентарь Steam отдаёт НЕ ВСЕ предметы. На живом
// клиенте Steam вернул 61 предмет при собственном total_inventory_count: 71,
// и среди пропавших были ★ Butterfly Knife | Scorched ($419.95) и
// ★ Navaja Knife | Doppler Phase 4 — те самые, из-за которых люди писали,
// что "сайт не видит скины, хотя Skinbux их берёт".
//
// Плюс здесь сразу приходит то, чего у Steam нет вообще: phase у дopplerов
// (мы отправляли null при продаже), float с паттерном и флаг sellAccept —
// берут ли предмет в принципе.
//
// ⚠️ Поля отличаются от документации: рабочий флаг — sellAccept (boolean,
// ровно совпадает с наличием price), а accepted приходит false у всех
// предметов и бесполезен. Проверено на реальном ответе.
const BASE = "https://api.skinbux.com/v1";

// Кэш на минуту — как у Steam-версии: страницу могут открыть несколько раз
// подряд, и дёргать чужой API на каждый F5 незачем.
const CACHE_TTL_MS = 60 * 1000;
const MAX_CACHED_USERS = 200;
const inventoryCache = new Map(); // steamId -> { items, at }

function remember(steamId, items) {
  if (inventoryCache.size >= MAX_CACHED_USERS && !inventoryCache.has(steamId)) {
    inventoryCache.delete(inventoryCache.keys().next().value);
  }
  inventoryCache.set(steamId, { items, at: Date.now() });
}

function normalizeItem(raw) {
  return {
    assetId: String(raw.assetid),
    marketHashName: raw.market_hash_name,
    tradable: !!raw.tradable,
    tradableAfter: null, // Skinbux не присылает дату разблокировки
    phase: raw.phase || null,
    sellAccept: raw.sellAccept === true,
    // price — в центах и только у тех, что принимают. Это их собственная
    // оценка ИМЕННО этого предмета (с учётом фазы), поэтому при продаже она
    // точнее, чем усреднённый bid из общего прайс-листа.
    skinbuxPriceCents: raw.price ?? null,
    float: raw.inspect?.float != null ? Number(raw.inspect.float) : null,
    pattern: raw.inspect?.pattern ?? null,
    icon: raw.icon_url
      ? `https://community.akamai.steamstatic.com/economy/image/${raw.icon_url}/512fx512f`
      : null,
  };
}

async function fetchUserInventory(apiKey, steamId, { force = false } = {}) {
  if (!apiKey) throw new Error("SKINBUX_API_KEY не задан в .env");

  const cached = inventoryCache.get(steamId);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.items;

  let res;
  try {
    res = await fetch(`${BASE}/inventory/user?steamId=${encodeURIComponent(steamId)}`, {
      headers: { "x-api-key": apiKey },
    });
  } catch (err) {
    if (cached) return cached.items;
    throw err;
  }

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    if (cached) return cached.items;
    const err = new Error(data?.error?.message || `Skinbux ответил ${res.status}`);
    err.code = data?.error?.code;
    throw err;
  }

  const items = (data.data?.inventory || []).map(normalizeItem);
  remember(steamId, items);
  return items;
}

module.exports = { fetchUserInventory };
