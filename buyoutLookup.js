// Цена моментального выкупа (skin.place, skins.com) для одного предмета —
// по той же схеме, что владелец делал руками:
//   1. ищем лот этого предмета на CSFloat (самый дешёвый, с нужным float);
//   2. берём Steam ID продавца из его стола;
//   3. переводим в номер для трейд-ссылки (SteamID64 − 76561197960265728);
//   4. смотрим инвентарь этого аккаунта на площадке — там цена выкупа;
//   5. находим в нём именно этот экземпляр и берём его цену.
//
// Общего прайса у этих площадок нет, поэтому только по запросу и с кэшем:
// каждая проверка — их запросы из их лимита.
//
// Площадка подключается адаптером из sources/: он сам ходит в её API и
// отдаёт предметы в общем виде { name, phase, float, price, priceReal,
// skipReason, raw }. Сопоставление по названию, фазе и float — здесь, общее.
const { stripPhaseSuffix } = require("./itemName");
const { steamId64ToPartner } = require("./steamId");
const skinplace = require("./sources/skinplace");
const skins = require("./sources/skins");

const SOURCES = { skinplace, skins };

const CSFLOAT_API = "https://csfloat.com/api/v1/listings";
const RESULT_TTL_MS = 30 * 60 * 1000;
const MAX_SELLERS = 2; // больше — это уже не "проверить цену", а обход их лимита

// float у площадок бывает округлён до 6 знаков — сравниваем с таким допуском.
const FLOAT_TOLERANCE = 2e-6;

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

/**
 * Почему у продавца не нашёлся предмет — с тем, что у него есть похожего.
 * Без этого "нет предмета" не отличить от того, что площадка пишет фазу или
 * название не так, как мы ждём.
 */
function missText(items, base, phase) {
  const label = (it) => `${it.name}${it.phase ? ` [${it.phase}]` : ""}`;
  const sameName = items.filter((it) => it.name === base);
  if (sameName.length) {
    return `у продавца есть ${base}, но не ${phase}: ${[...new Set(sameName.map(label))].slice(0, 4).join(", ")}`;
  }
  const skin = base.split(" | ")[1]?.replace(/\s*\(.*$/, "") || base;
  const similar = [...new Set(items.filter((it) => it.name?.includes(skin)).map(label))].slice(0, 4);
  return similar.length
    ? `в инвентаре продавца нет ${base}${phase ? ` [${phase}]` : ""}; похожее: ${similar.join(", ")}`
    : "в инвентаре продавца этого предмета уже нет";
}

/**
 * Цена выкупа предмета на площадке.
 * source — "skinplace" | "skins".
 * marketHashName — как на сайте, с суффиксом фазы для доплеров
 * ("★ Talon Knife | Doppler (Minimal Wear) - Ruby").
 */
async function buyoutPrice(source, marketHashName, { minFloat = null, maxFloat = null, debug = false } = {}) {
  const adapter = SOURCES[source];
  if (!adapter) throw new Error(`Неизвестная площадка: ${source}`);

  const cacheKey = `${source}|${marketHashName}|${minFloat}|${maxFloat}`;
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
    const isWanted = (it) => it.name === base && (!phase || !it.phase || it.phase === phase);
    let inv;
    try {
      inv = await adapter.findItems(partner, {
        steamId: listing.steamId,
        base,
        phase,
        isWanted,
        hintPrice: listing.csfloatPrice,
      });
    } catch (err) {
      // Протухший вход — дальше пробовать бессмысленно.
      if (err.auth) throw err;
      tried.push(err.message);
      continue;
    }

    // Ищем именно этот экземпляр: то же название, та же фаза и тот же float,
    // что у лота. Фазу проверяем отдельно — в названии у площадок её нет.
    const candidates = inv.items.filter(isWanted);
    const exact =
      listing.float != null
        ? candidates.find((it) => it.float != null && Math.abs(it.float - listing.float) < FLOAT_TOLERANCE)
        : null;
    const item = exact || candidates[0];
    if (!item) {
      tried.push(missText(inv.items, base, phase) + (inv.note ? ` (${inv.note})` : ""));
      continue;
    }

    const result = {
      ok: item.price != null,
      source,
      price: item.price,
      priceReal: item.priceReal ?? null,
      // Цена есть всегда, но часть предметов площадка сейчас не берёт.
      instant: !item.skipReason,
      skipReason: item.skipReason || null,
      matchedBy: exact ? "float" : "name",
      floatRange,
      csfloatPrice: listing.csfloatPrice,
      float: item.float ?? listing.float,
      phase: item.phase || phase || null,
      limits: inv.limits || null,
      checkedAt: new Date().toISOString(),
    };
    cache.set(cacheKey, { at: Date.now(), result });
    // Для отладки формата: весь предмет как его прислала площадка.
    return debug ? { ...result, rawItem: item.raw } : result;
  }

  return { ok: false, reason: `Не удалось получить цену: ${tried.join("; ") || "нет подходящих продавцов"}` };
}

module.exports = { buyoutPrice, SOURCES };
