// Наші власні скіни (те, що лежить у мене на акаунті, trades.json status
// "holding") — на вітрині "Купити скіни" як P2P-лоти: трейд відправляю я сам,
// тому не Instant. Колишня сторінка "Наші скіни" (/my-skins) тепер веде сюди.
//
// Ціна — та сама, що була на "Наших скінах" (trades.listPublicHoldings:
// Youpin + відсоток, не нижче викупу + 1%, або ручна askPrice).
// Предмети під трейд-баном теж показуємо — з датою, коли їх можна віддати.
// Предмет, на який є активне замовлення (skinbuxPurchases, kind "own"),
// з вітрини зникає, щоб його не купили двічі.
const trades = require("./trades");
const { parseItemName, matchesSearchQuery } = require("./itemName");
const { categoryOf, weaponOf } = require("./itemCategory");

const CACHE_MS = 60 * 1000;
const WEAR_CODE = { "Factory New": "FN", "Minimal Wear": "MW", "Field-Tested": "FT", "Well-Worn": "WW", "Battle-Scarred": "BS" };

let cache = { at: 0, items: null };

/**
 * Усі наші предмети в наявності (без урахування бронювань), нормалізовані під
 * вітрину. priceKey — ключ рядка прайсу (доплери з " - <фаза>"), по ньому
 * наші лоти зводяться з лотами Skinbux того ж предмета.
 */
async function allItems({ owner, config, rows }) {
  if (cache.items && Date.now() - cache.at < CACHE_MS) return cache.items;
  const holdings = await trades.listPublicHoldings(owner, config, rows);
  const items = holdings.map((h) => {
    const { baseName, wear: wearRaw, phase } = parseItemName(h.marketHashName);
    const wear = phase && wearRaw ? wearRaw.replace(` · ${phase}`, "") : wearRaw;
    return {
      ownId: String(h.id),
      priceKey: h.marketHashName,
      marketHashName: h.marketHashName,
      name: baseName,
      wear: WEAR_CODE[wear] || null,
      phase: phase || null,
      stattrak: h.marketHashName.includes("StatTrak™"),
      souvenir: h.marketHashName.startsWith("Souvenir "),
      float: h.floatValue ?? null,
      price: h.price,
      locked: !!h.isLocked,
      unlockAt: h.unlockAt,
      icon: h.imageFull || h.image || null,
    };
  });
  cache = { at: Date.now(), items };
  return items;
}

function invalidate() {
  cache = { at: 0, items: null };
}

/** Предмети, доступні до покупки: мінус ті, на які вже є замовлення. */
async function available(ctx, reservedIds) {
  return (await allItems(ctx)).filter((it) => !reservedIds.has(it.ownId));
}

/** Фільтри каталогу (ті самі параметри, що в /api/public/market). */
function filter(items, query) {
  if (query.delivery === "instant") return [];
  const q = String(query.q || "").trim();
  const wears = new Set(String(query.wear || "").split(",").filter(Boolean));
  const weapons = new Set(String(query.weapon || "").split(",").filter(Boolean));
  const min = parseFloat(query.min);
  const max = parseFloat(query.max);
  const out = items.filter((it) => {
    if (q && !matchesSearchQuery(it.marketHashName, q)) return false;
    if (query.category && categoryOf(it.marketHashName) !== query.category) return false;
    if (weapons.size && !weapons.has(weaponOf(it.marketHashName))) return false;
    if (wears.size && !wears.has(it.wear || "")) return false;
    if (query.special === "stattrak" && !it.stattrak) return false;
    if (query.special === "souvenir" && !it.souvenir) return false;
    if (query.special === "normal" && (it.stattrak || it.souvenir)) return false;
    if (Number.isFinite(min) && it.price < min) return false;
    if (Number.isFinite(max) && it.price > max) return false;
    return true;
  });
  return out.sort((a, b) => (query.sort === "price_asc" ? a.price - b.price : b.price - a.price));
}

/** Лот для сторінки предмета (той самий вигляд, що в лотів Skinbux). */
function asLot(it) {
  return {
    id: `own:${it.ownId}`,
    own: true,
    delivery: "p2p",
    float: it.float,
    pattern: null,
    stickers: [],
    price: it.price,
    locked: it.locked,
    unlockAt: it.unlockAt,
    inspectLink: null,
  };
}

/** Картка каталогу / шапка сторінки предмета — без внутрішніх полів. */
function publicItem(it) {
  return {
    ownId: it.ownId,
    marketHashName: it.marketHashName,
    name: it.name,
    wear: it.wear,
    phase: it.phase,
    stattrak: it.stattrak,
    souvenir: it.souvenir,
    float: it.float,
    price: it.price,
    locked: it.locked,
    unlockAt: it.unlockAt,
    icon: it.icon,
  };
}

module.exports = { allItems, available, filter, asLot, publicItem, invalidate };
