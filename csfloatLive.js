// Живой поток новых лотов CSFloat для бота арбитража (telegramArbBot.js).
//
// Обычный скан бота идёт по таблице раз в 5 минут, а в таблице у CSFloat
// только агрегированный ask от cs2.sh — к моменту уведомления дешёвый лот
// давно купили. Для связки "купить на CSFloat по ask" бот вместо этого раз в
// 30 секунд берёт с самого CSFloat последние выставленные лоты (один запрос,
// sort_by=most_recent) и сравнивает цену каждого НОВОГО лота с ценой продажи
// из таблицы. Так уведомление приходит про конкретный лот со ссылкой на него.
//
// Лимиты CSFloat API: читаем x-ratelimit-* из ответа, на 429 замолкаем до
// сброса окна — дальше ломиться бессмысленно, а ключ общий с остальным сайтом.
const CSFLOAT_API = "https://csfloat.com/api/v1/listings";
const PAGE_SIZE = 50;
const SEEN_MAX = 5000;
// Лот старше этого не считаем "новым": после смены фильтра (другой min_price)
// в выдачу попадают старые лоты, которых мы раньше просто не видели.
const MAX_AGE_MS = 10 * 60 * 1000;

function createState() {
  return { seen: new Set(), order: [], seeded: false, pausedUntil: 0 };
}

function remember(state, id) {
  if (state.seen.has(id)) return;
  state.seen.add(id);
  state.order.push(id);
  if (state.order.length > SEEN_MAX) state.seen.delete(state.order.shift());
}

/**
 * Новые лоты с прошлого вызова. Первый вызов только запоминает текущую
 * выдачу — после рестарта сервера не заваливаем чат уже виденным.
 * minPriceUsd — общий нижний порог подписчиков (меньше мелочи в выдаче,
 * значит 50 лотов покрывают больше времени).
 */
async function fetchNewListings(state, { apiKey, minPriceUsd = null }) {
  if (!apiKey) throw new Error("CSFLOAT_API_KEY не задан в .env");
  if (Date.now() < state.pausedUntil) return [];

  const query = new URLSearchParams({ limit: String(PAGE_SIZE), sort_by: "most_recent", type: "buy_now" });
  if (minPriceUsd != null) query.set("min_price", String(Math.round(minPriceUsd * 100)));

  const res = await fetch(`${CSFLOAT_API}?${query}`, {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 429) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    state.pausedUntil = reset > 0 ? reset * 1000 : Date.now() + 5 * 60 * 1000;
    throw new Error(`CSFloat 429 — пауза до ${new Date(state.pausedUntil).toISOString()}`);
  }
  if (!res.ok) throw new Error(`CSFloat ответил ${res.status}`);

  const data = await res.json();
  const list = Array.isArray(data) ? data : data.data || [];

  const now = Date.now();
  const fresh = [];
  for (const l of list) {
    if (!l?.id || state.seen.has(l.id)) continue;
    remember(state, l.id);
    const createdAt = Date.parse(l.created_at);
    if (Number.isFinite(createdAt) && now - createdAt > MAX_AGE_MS) continue;
    fresh.push(normalize(l));
  }

  const firstRun = !state.seeded;
  state.seeded = true;
  // Все 50 лотов новые — значит за интервал выставили больше, чем помещается
  // в одну страницу, и часть мы пропустили. Пишем в лог, чтобы было видно.
  if (!firstRun && list.length === PAGE_SIZE && fresh.length === PAGE_SIZE) {
    console.warn("[csfloat-live] все 50 лотов новые — часть лотов между опросами могла пройти мимо");
  }
  return firstRun ? [] : fresh;
}

function normalize(l) {
  const item = l.item || {};
  const name = item.market_hash_name || "";
  return {
    id: String(l.id),
    url: `https://csfloat.com/item/${l.id}`,
    // Ключ строки таблицы: у доплеров фаза идёт суффиксом (см. itemName.js).
    rowKey: item.phase ? `${name} - ${item.phase}` : name,
    name,
    phase: item.phase || null,
    price: Math.round(Number(l.price)) / 100,
    float: item.float_value ?? null,
    paintSeed: item.paint_seed ?? null,
    stickers: Array.isArray(item.stickers) ? item.stickers.length : 0,
    // Для автобаргов (csfloatAutoBargain.js): насколько продавец пускает
    // скидку — в базисных пунктах (1000 = 10%), и мин. цена барга, если
    // CSFloat её отдаёт. Нет поля (или 0 — непонятно, "запрещено" это или
    // "по умолчанию") — null, тогда берём assumedMaxDiscountPercent.
    maxOfferDiscount: Number(l.max_offer_discount) > 0 ? Number(l.max_offer_discount) : null,
    minOfferPrice: Number(l.min_offer_price) > 0 ? Math.round(Number(l.min_offer_price)) / 100 : null,
  };
}

module.exports = { createState, fetchNewListings, normalize };
