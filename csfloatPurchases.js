// Импорт покупок с CSFloat в трекер сделок: когда buy order исполняется,
// предмет приходит в инвентарь, а в таблицу его надо заносить руками — после
// полусотни сработавших ордеров это безнадёжно. Здесь мы забираем историю
// сделок ролью "покупатель" прямо из CSFloat и отдаём готовые записи.
//
// Эндпоинт /api/v1/me/trades в публичной документации CSFloat не описан (там
// только листинги), им пользуется сам сайт. Поэтому разбор ответа нарочно
// терпимый: поля ищем в нескольких местах и по нескольким именам, а всё, из
// чего не вышло достать название и цену, отбрасываем и считаем в skipped —
// лучше не импортировать сделку, чем записать её с пустой ценой.
// Адрес можно подменить (CSFLOAT_BASE_URL) — так импорт проверяется на
// заглушке, не трогая боевой аккаунт CSFloat.
const BASE_URL = process.env.CSFLOAT_BASE_URL || "https://csfloat.com";
const PAGE_LIMIT = 100;
const MAX_PAGES = 20; // 2000 сделок — с запасом, дальше почти наверняка зацикливание

// Состояния, в которых предмет к нам не приедет: деньги вернулись, заносить
// нечего.
const DEAD_STATES = new Set(["cancelled", "canceled", "failed", "expired", "refunded", "reverted", "rejected"]);
// Состояния, которые сами по себе означают завершённую покупку.
const DONE_STATES = new Set(["completed", "verified", "accepted", "success"]);
// Steam ETradeOfferState: 3 — обмен принят, предмет уже в инвентаре.
const STEAM_OFFER_ACCEPTED = 3;

/**
 * Покупка ли это. Ориентируемся не на state сделки, а на то, дошёл ли
 * предмет: у CSFloat сделка висит в "pending" до конца защиты покупателя
 * (verify_sale_at — это ещё неделя после того, как вещь уже лежит в
 * инвентаре), и по state её легко принять за незавершённую.
 */
function isReceivedPurchase(raw) {
  const state = String(pick(raw, ["state", "status"]) || "").toLowerCase();
  if (DEAD_STATES.has(state)) return false;
  if (DONE_STATES.has(state)) return true;
  if (pick(raw, ["accepted_at", "verified_at"])) return true;
  return Number(pick(raw, ["steam_offer.state"])) === STEAM_OFFER_ACCEPTED;
}

/** GET к CSFloat с ключом владельца. Ошибку отдаём человеку как есть. */
async function apiGet(apiKey, path) {
  const res = await fetch(BASE_URL + path, {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 200);
    try {
      message = JSON.parse(text).message || message;
    } catch {
      // не JSON — покажем как есть
    }
    throw new Error(`CSFloat ${res.status}: ${message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("CSFloat вернул не JSON — возможно, ключ не подходит");
  }
}

/** Массив сделок из ответа, в какой бы обёртке он ни пришёл. */
function tradesOf(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["trades", "data", "results"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

/** Первое непустое значение по цепочке путей вида "contract.item.name". */
function pick(obj, paths) {
  for (const path of paths) {
    let value = obj;
    for (const part of path.split(".")) value = value?.[part];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

/**
 * Одна сделка CSFloat -> запись для трекера. null, если это не покупка или
 * не хватает названия/цены.
 */
function normalizeTrade(raw) {
  if (!isReceivedPurchase(raw)) return null;

  const marketHashName = pick(raw, [
    "contract.item.market_hash_name",
    "item.market_hash_name",
    "contract.market_hash_name",
    "market_hash_name",
  ]);
  // Цена у CSFloat в центах. price — то, что заплатил покупатель.
  const cents = Number(
    pick(raw, ["price", "contract.price", "total_price", "contract.total_price", "buyer_price"])
  );
  if (!marketHashName || !Number.isFinite(cents) || cents <= 0) return null;

  return {
    // По нему отличаем уже импортированные сделки от новых.
    externalId: `csfloat:${pick(raw, ["id", "trade_id", "contract.id"]) || ""}`,
    marketHashName: String(marketHashName),
    buyPrice: Math.round(cents) / 100,
    // Когда предмет реально к нам приехал. contract.created_at тут не годится:
    // это дата появления лота у продавца (у Deagle — за две недели до покупки).
    buyDate: pick(raw, ["accepted_at", "created_at", "verified_at"]) || null,
    // Конец защиты сделки у CSFloat — те же 7 дней, что предмет нельзя
    // передавать дальше, только точной датой площадки, а не нашей прикидкой.
    unlockAt: pick(raw, ["trade_protection_ends_at"]) || null,
    floatValue: Number(pick(raw, ["contract.item.float_value", "item.float_value"])) || null,
    inspectLink: pick(raw, ["contract.item.inspect_link", "item.inspect_link"]),
  };
}

/**
 * Все покупки владельца на CSFloat, от свежих к старым. Постранично, пока
 * страницы не кончатся: сколько именно сделок отдаёт одна страница, заранее
 * неизвестно, поэтому ориентируемся на пустой ответ.
 */
async function fetchPurchases(apiKey, { maxPages = MAX_PAGES } = {}) {
  if (!apiKey) throw new Error("CSFLOAT_API_KEY не задан в .env");

  const purchases = [];
  let skipped = 0;
  let fetched = 0;

  for (let page = 0; page < maxPages; page++) {
    const payload = await apiGet(apiKey, `/api/v1/me/trades?role=buyer&page=${page}&limit=${PAGE_LIMIT}`);
    const batch = tradesOf(payload);
    if (!batch.length) break;
    fetched += batch.length;

    for (const raw of batch) {
      const trade = normalizeTrade(raw);
      if (trade) purchases.push(trade);
      else skipped++;
    }
    if (batch.length < PAGE_LIMIT) break;
  }

  return { purchases, fetched, skipped };
}

module.exports = { fetchPurchases, normalizeTrade, tradesOf, BASE_URL };
