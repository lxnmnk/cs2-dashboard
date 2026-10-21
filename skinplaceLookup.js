// Цена skin.place для одного предмета — по той же схеме, что владелец
// делал руками:
//   1. ищем лот этого предмета на CSFloat (самый дешёвый, с нужным float);
//   2. берём Steam ID продавца из его стола;
//   3. переводим в номер для трейд-ссылки (SteamID64 − 76561197960265728);
//   4. смотрим инвентарь этого аккаунта в skin.place — там цена выкупа;
//   5. находим в нём именно этот экземпляр и берём его цену.
//
// Общего прайса у skin.place нет, поэтому только по запросу и с кэшем:
// каждая проверка — их запрос из лимита 15 в минуту.
const { fetchInventory, steamId64ToPartner } = require("./sources/skinplace");
const { stripPhaseSuffix } = require("./itemName");

const CSFLOAT_API = "https://csfloat.com/api/v1/listings";
const RESULT_TTL_MS = 30 * 60 * 1000;
const MAX_SELLERS = 2; // больше — это уже не "проверить цену", а обход их лимита

// Фаза доплера -> paint_index на CSFloat. market_hash_name у всех фаз один,
// и без paint_index поиск вернул бы самые дешёвые фазы, а не нужную.
const PAINT_INDEX = {
  Doppler: { Ruby: 415, Sapphire: 416, "Black Pearl": 417, "Phase 1": 418, "Phase 2": 419, "Phase 3": 420, "Phase 4": 421 },
  "Gamma Doppler": { Emerald: 568, "Phase 1": 569, "Phase 2": 570, "Phase 3": 571, "Phase 4": 572 },
};

const cache = new Map();

function paintIndexFor(baseName, phase) {
  if (!phase) return null;
  const finish = /Gamma Doppler/.test(baseName) ? "Gamma Doppler" : /Doppler/.test(baseName) ? "Doppler" : null;
  return finish ? PAINT_INDEX[finish][phase] ?? null : null;
}

async function csfloatListings(baseName, { phase, minFloat, maxFloat }) {
  const key = process.env.CSFLOAT_API_KEY;
  if (!key) throw new Error("CSFLOAT_API_KEY не задан в .env");

  const query = new URLSearchParams({ limit: "20", sort_by: "lowest_price", type: "buy_now", market_hash_name: baseName });
  const paint = paintIndexFor(baseName, phase);
  if (paint) query.set("paint_index", String(paint));
  if (minFloat != null) query.set("min_float", String(minFloat));
  if (maxFloat != null) query.set("max_float", String(maxFloat));

  const res = await fetch(`${CSFLOAT_API}?${query}`, { headers: { Authorization: key } });
  if (!res.ok) throw new Error(`CSFloat ответил ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : data.data || [];

  return list
    .filter((l) => l.seller?.steam_id) // закрытый стол — Steam ID не узнать
    .filter((l) => !phase || !l.item?.phase || l.item.phase === phase) // страховка, если paint_index не тот
    .map((l) => ({
      steamId: String(l.seller.steam_id),
      float: l.item?.float_value ?? null,
      csfloatPrice: Math.round(Number(l.price)) / 100,
      phase: l.item?.phase || null,
    }));
}

// Поля предмета у skin.place (сверено по живому ответу):
//   market_hash_name — без фазы, фаза отдельно в phase;
//   floatvalue — float, округлённый до 6 знаков;
//   price — сколько они платят; price_real — их цена до своей комиссии;
//   skip_reason — почему сейчас не выкупят (цена при этом есть).
// pick оставлен на случай, если они переименуют поле.
const pick = (o, keys) => keys.map((k) => o?.[k]).find((v) => v !== undefined && v !== null);
const itemName = (it) => pick(it, ["market_hash_name", "market_name", "name"]);
const itemFloat = (it) => {
  const v = pick(it, ["floatvalue", "float", "float_value", "paintwear"]);
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
};
const itemPrice = (it) => {
  const v = pick(it, ["price", "price_original", "instant_price"]);
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
};

// float у них округлён до 6 знаков — сравниваем с таким же допуском.
const FLOAT_TOLERANCE = 2e-6;

const SKIP_REASONS = {
  item_liquidity_limit: "сейчас моментально не выкупают — лимит по ликвидности этого предмета",
};
const skipText = (reason) => (reason ? SKIP_REASONS[reason] || reason : null);

/**
 * Цена skin.place за предмет.
 * marketHashName — как на сайте, с суффиксом фазы для доплеров
 * ("★ Talon Knife | Doppler (Minimal Wear) - Ruby").
 */
async function skinplacePrice(marketHashName, { minFloat = null, maxFloat = null, debug = false } = {}) {
  const cacheKey = `${marketHashName}|${minFloat}|${maxFloat}`;
  const hit = cache.get(cacheKey);
  if (!debug && hit && Date.now() - hit.at < RESULT_TTL_MS) return { ...hit.result, cached: true };

  const { base, phase } = stripPhaseSuffix(marketHashName);
  let listings = await csfloatListings(base, { phase, minFloat, maxFloat });
  // Рядом по float никто не продаёт — берём любой экземпляр того же качества:
  // цена чуть менее точная, но лучше, чем ничего.
  let floatRange = minFloat != null || maxFloat != null ? "near" : "any";
  if (!listings.length && floatRange === "near") {
    listings = await csfloatListings(base, { phase });
    floatRange = "any";
  }
  if (!listings.length) {
    return { ok: false, reason: "На CSFloat нет открытых лотов с таким предметом — не у кого посмотреть цену" };
  }

  const tried = [];
  for (const listing of listings.slice(0, MAX_SELLERS)) {
    const partner = steamId64ToPartner(listing.steamId);
    let inv;
    try {
      inv = await fetchInventory(partner);
    } catch (err) {
      // Протухшая кука — дальше пробовать бессмысленно.
      if (/сессию|SKINPLACE_/.test(err.message)) throw err;
      tried.push(err.message);
      continue;
    }

    // Ищем именно этот экземпляр: то же название, та же фаза и тот же float,
    // что у лота. Фазу проверяем отдельно — в названии у skin.place её нет.
    const candidates = inv.items.filter(
      (it) => itemName(it) === base && (!phase || !it.phase || it.phase === phase)
    );
    const exact =
      listing.float != null
        ? candidates.find((it) => itemFloat(it) != null && Math.abs(itemFloat(it) - listing.float) < FLOAT_TOLERANCE)
        : null;
    const item = exact || candidates[0];
    if (!item) {
      tried.push("в инвентаре продавца этого предмета уже нет");
      continue;
    }

    const price = itemPrice(item);
    const priceReal = Number(item.price_real);
    const result = {
      ok: price != null,
      price,
      priceReal: Number.isFinite(priceReal) ? priceReal : null,
      // Цена есть всегда, но часть предметов они сейчас не берут.
      instant: !item.skip_reason,
      skipReason: skipText(item.skip_reason),
      matchedBy: exact ? "float" : "name",
      floatRange,
      csfloatPrice: listing.csfloatPrice,
      float: itemFloat(item) ?? listing.float,
      phase: item.phase || phase || null,
      limits: inv.limits,
      checkedAt: new Date().toISOString(),
    };
    cache.set(cacheKey, { at: Date.now(), result });
    // Для отладки формата: весь предмет как его прислал skin.place.
    return debug ? { ...result, rawItem: item } : result;
  }

  return { ok: false, reason: `Не удалось получить цену: ${tried.join("; ") || "нет подходящих продавцов"}` };
}

module.exports = { skinplacePrice, itemName, itemFloat, itemPrice };
