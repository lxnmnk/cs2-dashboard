// Вітрина "Купити скіни" з лотів Skinbux (замість прайсу Youpin).
//
// Skinbux Partner API (https://api.skinbux.com/docs):
//   GET /v2/inventory/search/grouped — картки: один рядок на предмет (стек),
//       мінімальна ціна, кількість лотів, діапазон float;
//   GET /v2/inventory/search?stackId= — конкретні лоти стека: float, паттерн,
//       наліпки, ціна, deliveryType: "instant" (склад Skinbux, трейд за
//       хвилини) або "manual" (P2P: віддає продавець, до 12 год).
//
// Лоти під трейдлоком не показуємо (maxTradeholdDays=0) — так вирішив власник.
//
// Ліміт запитів у Skinbux — 120 на хвилину на ВЕСЬ акаунт (і на продаж
// клієнтів, і на панель). Тому вітрина бере собі не більше SITE_CALLS_PER_MIN,
// а однакові запити віддає з кешу. Не вистачило ліміту — віддаємо старий кеш,
// якщо є, інакше помилку "спробуй за хвилину".
const BASE = "https://api.skinbux.com";
const APP_ID = 730;
const PAGE_SIZE = 60;
const SITE_CALLS_PER_MIN = 60;
const LIST_TTL_MS = 2 * 60 * 1000;
const STACK_TTL_MS = 60 * 1000;
const CACHE_MAX = 500;
const ICON_BASE = "https://community.akamai.steamstatic.com/economy/image/";

// Наші вкладки -> категорії Skinbux (значення перевірені на живому API).
const CATEGORY_MAP = {
  knife: ["knife"],
  gloves: ["gloves"],
  rifle: ["rifle"],
  sniper: ["sniper_rifle"],
  pistol: ["pistol"],
  smg: ["smg"],
  shotgun: ["shotgun"],
  machinegun: ["machinegun"],
  sticker: ["sticker"],
  charm: ["charm", "keychain"],
  agent: ["agent"],
  case: ["container"],
  other: ["music_kit", "patch", "graffiti", "collectible", "key", "tool", "pass"],
};
const WEAR_BY_CODE = { FN: "factory new", MW: "minimal wear", FT: "field-tested", WW: "well-worn", BS: "battle-scarred" };
const CODE_BY_WEAR = Object.fromEntries(Object.entries(WEAR_BY_CODE).map(([k, v]) => [v, k]));

const round2 = (n) => Math.round(n * 100) / 100;

// ---- Ліміт і кеш ----
const calls = [];
function takeCall() {
  const now = Date.now();
  while (calls.length && now - calls[0] > 60000) calls.shift();
  if (calls.length >= SITE_CALLS_PER_MIN) return false;
  calls.push(now);
  return true;
}

const cache = new Map(); // key -> { at, data }
function cacheGet(key, ttl) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  return null;
}
function cacheSet(key, data) {
  cache.set(key, { at: Date.now(), data });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

class MarketError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function apiGet(path, { force = false } = {}) {
  const apiKey = process.env.SKINBUX_API_KEY;
  if (!apiKey) throw new MarketError("NOT_CONFIGURED", "SKINBUX_API_KEY не задан");
  if (!takeCall() && !force) throw new MarketError("BUSY", "Skinbux rate limit (site share) reached");
  const res = await fetch(`${BASE}${path}`, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    throw new MarketError(res.status === 429 ? "BUSY" : "UPSTREAM", data?.error?.message || `Skinbux ${res.status}`);
  }
  return data;
}

/** Запит із кешем; без ліміту — останній кеш, навіть протухлий. */
async function cached(key, ttl, path) {
  const fresh = cacheGet(key, ttl);
  if (fresh) return fresh;
  try {
    const data = await apiGet(path);
    cacheSet(key, data);
    return data;
  } catch (err) {
    const stale = cache.get(key);
    if (err.code === "BUSY" && stale) return stale.data;
    throw err;
  }
}

// ---- Нормалізація ----
function iconUrl(hash) {
  if (!hash) return null;
  return /^https?:/.test(hash) ? hash : `${ICON_BASE}${hash}/360fx360f`;
}

/** Ціна клієнту в доларах: ціна Skinbux + наша націнка з панелі. */
function clientPrice(cents, markup) {
  return round2((cents / 100) * (1 + (Number(markup) || 0)));
}

function deliveryOf(type) {
  return type === "instant" ? "instant" : "p2p";
}

/** "★ StatTrak™ Butterfly Knife | Bright Water (Well-Worn)" -> частини для картки. */
function splitName(name, q) {
  const m = String(name).match(/^(.*?)(?: \(([^)]+)\))?$/);
  const base = m ? m[1] : name;
  return {
    name: base,
    wear: q?.exterior ? CODE_BY_WEAR[q.exterior] || null : null,
    phase: q?.doppler_phase || null,
  };
}

/**
 * Ключ рядка в нашому прайсі (cache.rows): доплери там лежать як
 * "<market_hash_name> - <фаза>" (sources/skinbux.js), фаза в Skinbux
 * називається так само ("Phase 2", "Ruby", "Black Pearl").
 */
function priceKeyOf(raw) {
  const mhn = raw.market_hash_name || raw.name;
  const phase = raw.qualities?.doppler_phase;
  return phase ? `${mhn} - ${phase}` : mhn;
}

function normalizeStack(s, markup) {
  const parts = splitName(s.market_hash_name || s.name, s.qualities);
  return {
    stackId: s.stackId,
    priceKey: priceKeyOf(s),
    marketHashName: s.name,
    name: parts.name,
    wear: parts.wear,
    phase: parts.phase,
    stattrak: !!s.qualities?.stattrak,
    souvenir: !!s.qualities?.souvenir,
    price: clientPrice(s.price?.sell ?? 0, markup),
    count: s.listingCount,
    minFloat: s.minFloat ?? null,
    maxFloat: s.maxFloat ?? null,
    icon: iconUrl(s.iconUrl),
    nameColor: s.qualities?.name_color || null,
  };
}

function normalizeListing(l, markup) {
  return {
    id: String(l.id),
    delivery: deliveryOf(l.deliveryType),
    float: l.floatNumber ?? l.inspect?.float ?? null,
    pattern: l.inspect?.pattern ?? null,
    stickers: (l.inspect?.stickers || [])
      .filter((s) => s && (s.name || s.iconUrl))
      .map((s) => ({ name: s.name || null, icon: iconUrl(s.iconUrl || s.icon_url) })),
    price: clientPrice(l.price?.sell ?? 0, markup),
    skinbuxCents: l.price?.sell ?? null,
    inspectLink: l.inspect_link || null,
  };
}

// ---- Запити вітрини ----
function stackQuery(query) {
  const p = new URLSearchParams({
    appId: String(APP_ID),
    limit: String(PAGE_SIZE),
    maxTradeholdDays: "0",
    sort: query.sort === "price_asc" ? "price" : "-price",
  });
  const page = Math.max(1, Math.min(150, parseInt(query.page, 10) || 1));
  if (page > 1) p.set("offset", String((page - 1) * PAGE_SIZE));
  if (query.delivery === "instant" || query.delivery === "p2p") p.set("delivery", query.delivery);
  const q = String(query.q || "").trim().slice(0, 100);
  if (q) p.set("name", q);
  for (const c of CATEGORY_MAP[query.category] || []) p.append("category", c);
  for (const w of String(query.weapon || "").split(",").filter(Boolean)) p.append("weapon", w.toLowerCase());
  for (const code of String(query.wear || "").split(",").filter(Boolean)) {
    if (WEAR_BY_CODE[code]) p.append("wear", WEAR_BY_CODE[code]);
  }
  if (query.special === "stattrak") p.set("statTrak", "true");
  if (query.special === "souvenir") p.set("souvenir", "true");
  if (query.special === "normal") {
    p.set("statTrak", "false");
    p.set("souvenir", "false");
  }
  return { params: p, page };
}

/**
 * Сторінка карток. min/max — у доларах НАШОЇ ціни (з націнкою): переводимо
 * назад у центи Skinbux, бо фільтрує він по своїй ціні.
 */
async function searchStacks(query, markup) {
  const { params, page } = stackQuery(query);
  const k = 1 + (Number(markup) || 0);
  const min = parseFloat(query.min);
  const max = parseFloat(query.max);
  if (Number.isFinite(min) && min > 0) params.set("minPriceCents", String(Math.floor((min / k) * 100)));
  if (Number.isFinite(max) && max > 0) params.set("maxPriceCents", String(Math.ceil((max / k) * 100)));
  const path = `/v2/inventory/search/grouped?${params}`;
  const data = await cached(`g:${params}`, LIST_TTL_MS, path);
  const total = Number(data.total) || 0;
  return {
    items: (data.data || []).map((s) => normalizeStack(s, markup)),
    page,
    total,
    pages: Math.max(1, Math.min(150, Math.ceil(total / PAGE_SIZE))),
  };
}

function listingsPath(stackId) {
  const p = new URLSearchParams({ appId: String(APP_ID), stackId, limit: "200", sort: "price", maxTradeholdDays: "0" });
  return `/v2/inventory/search?${p}`;
}

/** Усі вільні лоти одного предмета (усіх типів доставки). */
async function stackListings(stackId, markup) {
  if (!/^[a-f0-9]{32}$/.test(String(stackId || ""))) throw new MarketError("BAD_STACK", "bad stackId");
  const data = await cached(`s:${stackId}`, STACK_TTL_MS, listingsPath(stackId));
  const raw = (data.data || []).filter((l) => !(l.tradehold_days > 0) && l.available !== false);
  const first = data.data?.[0] || null;
  return {
    item: first
      ? {
          stackId,
          priceKey: priceKeyOf(first),
          marketHashName: first.name,
          ...splitName(first.market_hash_name || first.name, first.qualities),
          stattrak: !!first.qualities?.stattrak,
          souvenir: !!first.qualities?.souvenir,
          rarity: first.qualities?.rarity || null,
          category: first.qualities?.category || null,
          nameColor: first.qualities?.name_color || null,
          icon: iconUrl(first.iconUrl),
        }
      : null,
    listings: raw.map((l) => normalizeListing(l, markup)),
  };
}

/**
 * Свіжий стан одного лота перед купівлею — повз кеш і поза лімітом вітрини
 * (покупка важливіша за перегляд). null — лота вже немає або він під локом.
 */
async function freshListing(stackId, listingId) {
  if (!/^[a-f0-9]{32}$/.test(String(stackId || ""))) return null;
  const data = await apiGet(listingsPath(stackId), { force: true });
  cacheSet(`s:${stackId}`, data);
  const l = (data.data || []).find((x) => String(x.id) === String(listingId));
  if (!l || l.tradehold_days > 0 || l.available === false) return null;
  return l;
}

module.exports = {
  searchStacks,
  stackListings,
  freshListing,
  clientPrice,
  normalizeListing,
  priceKeyOf,
  splitName,
  deliveryOf,
  MarketError,
  CATEGORY_MAP,
  _cache: cache,
};
