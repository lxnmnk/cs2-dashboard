// Цены skins.com — сколько они платят за предмет при моментальной продаже.
//
// В их Trading API моментальной продажи нет. Цены видны только на странице
// skins.com/inventory, а её можно открыть на чужой инвентарь: Custom Delivery
// и трейд-ссылка. Страница грузит его запросом /secure/user/inventory с
// параметром customTradeUrl — им и пользуемся, по одному аккаунту за раз и
// только когда цену спросили (см. buyoutLookup.js). Настройку аккаунта при
// этом не трогаем: ссылка идёт только в запросе.
//
// Авторизация — заголовок Authorization от залогиненного владельца
// (SKINS_AUTH в .env, записывает skins-auth.js из скопированного cURL).
// В логи его не пишем никогда: по нему можно действовать от его имени.
//
// Инвентарь отдают страницами по 100, от дорогих к дешёвым, и умеют искать
// (параметр search, как поле поиска на странице). Ищем по названию скина —
// обычно хватает одной страницы. Если нет, листаем и останавливаемся, как
// только нашли или цены ушли сильно ниже цены лота на CSFloat.
const { tradeLinkFor } = require("../steamId");

const API = "https://api.skins.com/secure/user/inventory";
const MIN_GAP_MS = 3000;
const PAGE_TTL_MS = 10 * 60 * 1000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 4;
// Страница, где самый дешёвый предмет дешевле 40% цены на CSFloat, — значит,
// наш (он дороже) уже пролистан.
const PASSED_RATIO = 0.4;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

function authError(message) {
  return Object.assign(new Error(message), { auth: true });
}

let lastCall = 0;
let queue = Promise.resolve();

/** Запросы к skins.com идут строго по одному и с паузой. */
function throttled(fn) {
  const run = queue.then(async () => {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  queue = run.catch(() => {});
  return run;
}

const pageCache = new Map(); // `${partner}|${search}|${page}` -> { at, items, totalPages }

async function fetchPage(partner, search, page) {
  const key = `${partner}|${search}|${page}`;
  const cached = pageCache.get(key);
  if (cached && Date.now() - cached.at < PAGE_TTL_MS) return cached;

  const auth = process.env.SKINS_AUTH;
  if (!auth) throw authError("SKINS_AUTH не задан в .env — запусти node skins-auth.js");

  const query = new URLSearchParams({
    search,
    sortBy: "price",
    sortOrder: "desc",
    page: String(page),
    limit: String(PAGE_LIMIT),
    customTradeUrl: tradeLinkFor(partner),
  });

  return throttled(async () => {
    const res = await fetch(`${API}?${query}`, {
      headers: {
        Accept: "application/json",
        Authorization: auth,
        Origin: "https://skins.com",
        Referer: "https://skins.com/",
        "User-Agent": USER_AGENT,
      },
    });
    const text = await res.text();

    if (res.status === 401 || res.status === 403) {
      throw authError(
        `skins.com не принял вход (HTTP ${res.status}). Токен устарел — скопируй cURL заново, ` +
          "запусти node skins-auth.js и перезапусти сервер."
      );
    }
    if (res.status === 429) throw new Error("skins.com: превышен лимит запросов, попробуй через минуту");

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`skins.com ответил не JSON (HTTP ${res.status}) — возможно, проверка Cloudflare`);
    }
    if (!res.ok || data.success === false) {
      throw new Error(`skins.com: ${data.message || data.error || "ошибка"} (HTTP ${res.status})`);
    }

    const entry = {
      at: Date.now(),
      items: Array.isArray(data.data) ? data.data : [],
      totalPages: data.pagination?.totalPages ?? 1,
    };
    pageCache.set(key, entry);
    return entry;
  });
}

// Формат предмета skins.com не описан, и живой ответ мы пока видели только
// сверху (id, slug). Берём устойчиво — первый найденный вариант поля; точные
// имена сверим по выводу price-check.js --fields.
const pick = (o, keys) => keys.map((k) => o?.[k]).find((v) => v !== undefined && v !== null);
const num = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);

function normalize(it) {
  // "Not Accepted" на карточке — они этот предмет сейчас не берут.
  const accepted = pick(it, ["accepted", "isAccepted", "canSell", "sellable", "isSellable"]);
  return {
    name: pick(it, ["marketHashName", "market_hash_name", "fullName", "name"]) ?? null,
    phase: pick(it, ["phase", "dopplerPhase"]) ?? null,
    float: num(pick(it, ["float", "floatValue", "paintWear", "wear"])),
    price: num(pick(it, ["price", "instantPrice", "sellPrice", "value"])),
    priceReal: null,
    skipReason: accepted === false ? "skins.com сейчас этот предмет не принимает (Not Accepted)" : null,
    raw: it,
  };
}

/**
 * Что вписать в поиск: название скина без оружия и качества —
 * "AWP | Dragon Lore (Field-Tested)" -> "Dragon Lore". Так же ищет человек
 * на их странице, и это точно совпадёт, как бы они ни хранили полное имя.
 */
function searchTermFor(base) {
  const noWear = base.replace(/\s*\([^)]*\)\s*$/, "");
  const bar = noWear.indexOf(" | ");
  if (bar < 0) return noWear.replace(/^★\s*/, "");
  // У наклеек после названия ещё "(Holo) | Katowice 2014" — берём только имя.
  return noWear.slice(bar + 3).split(/ \(| \| /)[0];
}

/** Для buyoutLookup: ищем предмет и листаем страницы, пока не найдём. */
async function findItems(partner, { base, isWanted, hintPrice }) {
  const search = searchTermFor(base);
  const found = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { items, totalPages } = await fetchPage(partner, search, page);
    const normalized = items.map(normalize);
    found.push(...normalized.filter(isWanted));
    if (found.length || page >= totalPages || !normalized.length) break;

    const cheapest = Math.min(...normalized.map((it) => it.price ?? Infinity));
    if (hintPrice && cheapest < hintPrice * PASSED_RATIO) break;
  }
  return { items: found, limits: null };
}

module.exports = { findItems, searchTermFor };
