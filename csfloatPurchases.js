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
// CSFloat отдаёт по 50 сделок на страницу — просить больше бессмысленно, а
// считать "пришло меньше запрошенного, значит конец" на таком ответе нельзя:
// так импорт останавливался после первой же страницы.
const PAGE_LIMIT = 50;
const MAX_PAGES = 40; // 2000 сделок — дальше это уже не "последние покупки"
const DEFAULT_DAYS = 30;

// Состояния, в которых предмет к нам не приедет: деньги вернулись, заносить
// нечего.
const DEAD_STATES = new Set(["cancelled", "canceled", "failed", "expired", "refunded", "reverted", "rejected"]);
// Состояния, которые сами по себе означают завершённую покупку.
const DONE_STATES = new Set(["completed", "verified", "accepted", "success"]);
// Steam ETradeOfferState: 3 — обмен принят, предмет уже в инвентаре.
const STEAM_OFFER_ACCEPTED = 3;

/**
 * Дошёл ли предмет. У CSFloat сделка висит в "pending" до конца защиты
 * покупателя (verify_sale_at — это ещё неделя после того, как вещь уже лежит
 * в инвентаре), поэтому смотрим на принятый Steam-обмен, а не на state.
 */
function isReceived(raw) {
  const state = String(pick(raw, ["state", "status"]) || "").toLowerCase();
  if (DONE_STATES.has(state)) return true;
  if (pick(raw, ["accepted_at", "verified_at"])) return true;
  return Number(pick(raw, ["steam_offer.state"])) === STEAM_OFFER_ACCEPTED;
}

/**
 * Брать ли сделку при выбранном режиме.
 *   purchased — то же, что во вкладке "Purchased" на сайте CSFloat: сделки
 *               под защитой покупателя (state "pending"). Именно их обычно и
 *               надо занести — свежие покупки.
 *   all       — плюс те, у кого защита уже прошла ("verified"): нужно, если
 *               заносишь задним числом.
 * Отменённые и сорванные не берём никогда.
 */
function matchesMode(raw, mode) {
  const state = String(pick(raw, ["state", "status"]) || "").toLowerCase();
  if (DEAD_STATES.has(state)) return false;
  if (mode === "all") return isReceived(raw) || state === "pending";
  return state === "pending";
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
function normalizeTrade(raw, mode = "purchased") {
  if (!matchesMode(raw, mode)) return null;

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
    // Оплачено, но продавец ещё не отправил обмен: в таблицу такое заносить
    // можно (деньги уже ушли), но в списке это видно отдельной пометкой.
    received: isReceived(raw),
  };
}

/** Дата сделки для отсечки по сроку. */
function tradeTime(raw) {
  const iso = pick(raw, ["accepted_at", "created_at"]);
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Покупки владельца на CSFloat за последние days дней, от свежих к старым.
 *
 * Срок обязателен по делу, а не для красоты: у аккаунта полторы тысячи сделок
 * за все годы, и без отсечки трекер забился бы предметами, давно проданными
 * мимо него. Список приходит от новых к старым, поэтому на первой же сделке
 * старше отсечки перестаём листать.
 */
async function fetchPurchases(apiKey, { maxPages = MAX_PAGES, days = DEFAULT_DAYS, mode = "purchased" } = {}) {
  if (!apiKey) throw new Error("CSFLOAT_API_KEY не задан в .env");

  const cutoff = Date.now() - Math.max(1, Number(days) || DEFAULT_DAYS) * 86400000;
  const purchases = [];
  const seenIds = new Set();
  let skipped = 0;
  let fetched = 0;
  let reachedCutoff = false;

  for (let page = 0; page < maxPages && !reachedCutoff; page++) {
    const payload = await apiGet(apiKey, `/api/v1/me/trades?role=buyer&page=${page}&limit=${PAGE_LIMIT}`);
    const batch = tradesOf(payload);
    if (!batch.length) break;

    // Если сервер не понял page и вернул ту же страницу — выходим, иначе
    // крутились бы по кругу до maxPages.
    const fresh = batch.filter((raw) => {
      const id = String(pick(raw, ["id", "trade_id"]) || Math.random());
      if (seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });
    if (!fresh.length) break;
    fetched += fresh.length;

    for (const raw of fresh) {
      const time = tradeTime(raw);
      if (time !== null && time < cutoff) {
        reachedCutoff = true;
        continue;
      }
      const trade = normalizeTrade(raw, mode);
      if (trade) purchases.push(trade);
      else skipped++;
    }
  }

  return { purchases, fetched, skipped, mode, days: Math.max(1, Number(days) || DEFAULT_DAYS) };
}

module.exports = { fetchPurchases, normalizeTrade, tradesOf, BASE_URL };
