// Автобарги на CSFloat по лотам из live-ленты (опрос в telegramArbBot.js,
// управление и уведомления — бот csf_bargains, telegramBargainBot.js).
//
// Каждые 30 с приходят новые лоты CSFloat. Лот, который НЕ выгоден по полной
// цене, но стал бы выгоден по цене в пределах разрешённой скидки продавца,
// попадает сюда. У каждого правила (rules ниже) два порога:
//   openProfitPercent — с какого профита начинаем (первый барг);
//   minProfitPercent  — ниже какого профита не опускаемся (потолок цены).
// Например, под Skinbux: первый барг — цена, дающая 10% профита, а если
// продавец присылает контр-оффер, торгуемся до 8%. У правил без
// openProfitPercent запаса на торг нет: первый барг сразу по потолку.
//
// Контр-оффер продавца (наш барг он этим закрывает):
//   - цена не выше потолка → принимаем (если хватает денег сверх резерва);
//   - выше, но наш барг был ниже потолка → отвечаем контром по потолку;
//   - иначе — не отвечаем, пишем в Telegram; предложение истечёт само.
//
// Деньги:
//   - всегда оставляем reserveUsd (по умолчанию $1000) на балансе;
//   - висящий барг замораживает деньги, поэтому через ttlMinutes (30) без
//     ответа барг отменяем, а освободившиеся деньги идут на следующий лот из
//     очереди (самый выгодный, ещё не протухший).
//
// CSFloat замораживает сумму барга до 24 ч; отменить барг можно не раньше
// чем через 30 мин. Не известно только, показывает ли поле balance в /me уже
// за вычетом замороженного. Пока не узнали — считаем осторожно: balance минус
// сумма наших висящих баргов. После первого барга сравниваем баланс до и
// после и запоминаем ответ (reservesBalance в csfloatAutoBargains.json).
//
// Эндпоинты взяты из открытых клиентов (официальной документации нет):
//   POST   /offers {contract_id, price, cancel_previous_offer}
//   GET    /me/offers-timeline?limit=N
//   DELETE /offers/:id                 — отмена
//   POST   /offers/:id/accept          — принять контр-оффер продавца
//   POST   /offers/:id/counter-offer {price} — ответить контром
// Если CSFloat какой-то из них не примет — ошибка придёт в Telegram.
const fs = require("fs");
const path = require("path");
const { api } = require("./csfloatAutoList");
const { fetchBalance } = require("./csfloatAccount");
const { normalize: normalizeListing } = require("./csfloatLive");
const { paintIndexFor } = require("./buyoutLookup");

const STATE_FILE = path.join(__dirname, "csfloatAutoBargains.json");

const DEFAULTS = {
  enabled: false,
  // Ничего не отправляем, только пишем в Telegram, что отправили бы.
  dryRun: false,
  reserveUsd: 1000,
  ttlMinutes: 30,
  // Если лот не сообщает max_offer_discount — считаем, что продавец пускает
  // барги до столько % от цены.
  assumedMaxDiscountPercent: 10,
  // Лот проходит правила уже по полной цене — покупаем сразу, без барга.
  autoBuy: true,
  // Отвечать на контр-офферы продавцов (принять / контр на контр).
  answerCounters: true,
  // Кандидат ждёт денег в очереди не дольше этого — потом лот уже купили.
  queueMinutes: 15,
  maxQueue: 50,
  // Под что покупаем. Правило выполняется, если чистый профит (после
  // комиссий) не ниже minProfitPercent против КАЖДОЙ площадки из sell.
  // Из правил берётся то, что даёт самую высокую цену барга.
  rules: [
    { sell: ["youpin:bid", "skinbux:bid"], minProfitPercent: 7 },
    // Начинаем с 10% под Skinbux, на контр-оффер торгуемся до 8%.
    { sell: ["skinbux:bid"], openProfitPercent: 10, minProfitPercent: 8 },
    // Youpin ask − 7%, если Youpin bid не ниже этой цены и лот выставлен не
    // дороже 96% от Youpin ask (лоты "по рынку Youpin" на −7% не уступят).
    { fromAsk: "youpin:ask", discountPercent: 7, maxListPercentOfAsk: 96 },
  ],
};

function ruleLabel(rule) {
  if (rule.fromAsk) {
    const open = rule.openDiscountPercent != null && rule.openDiscountPercent !== rule.discountPercent ? `${rule.openDiscountPercent}%→` : "";
    return `${rule.fromAsk} −${open}${rule.discountPercent}% (bid не ниже${rule.maxListPercentOfAsk ? `, лот ≤ ${rule.maxListPercentOfAsk}% ask` : ""})`;
  }
  const open = rule.openProfitPercent != null && rule.openProfitPercent !== rule.minProfitPercent ? `${rule.openProfitPercent}%→` : "";
  return `${open}${rule.minProfitPercent}% под ${rule.sell.join(" + ")}`;
}
const MIN_TTL_MINUTES = 30;
const TICK_MS = 60 * 1000;
const CALL_GAP_MS = 1200;
const ERROR_REPEAT_MS = 15 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cents = (usd) => Math.round(usd * 100);
const usd = (c) => (Math.round(c) / 100).toFixed(2);

function loadState() {
  const empty = { settings: {}, offers: {}, tried: {}, counters: {}, reservesBalance: null };
  try {
    return { ...empty, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
  } catch {
    return empty;
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Пределы цены покупки (в центах) по правилу:
 *   max  — потолок: выше него правило не выполняется (minProfitPercent);
 *   open — с чего начинаем барг (openProfitPercent, по умолчанию = max).
 * Нет цены у какой-то площадки — правило не подходит (null).
 */
function ruleLimits(rule, row, sources, listCents) {
  const buyFee = sources.csfloat?.buyFee || 0;
  // Правило от ask: барг = ask − discountPercent, но только если bid той же
  // площадки не ниже этой цены (Youpin ask 100, bid ≥ 93 → барг 93) и лот
  // выставлен не дороже maxListPercentOfAsk % от ask.
  if (rule.fromAsk) {
    const [source] = rule.fromAsk.split(":");
    const ask = row.prices?.[source]?.ask;
    const bid = row.prices?.[source]?.bid;
    if (ask == null || bid == null || !sources[source]?.enabled) return null;
    if (rule.maxListPercentOfAsk != null && listCents > ask * rule.maxListPercentOfAsk) return null;
    const max = Math.floor(ask * (1 - rule.discountPercent / 100) * 100);
    if (Math.round(bid * 100) < max) return null;
    const open = Math.floor(ask * (1 - (rule.openDiscountPercent ?? rule.discountPercent) / 100) * 100);
    return { max, open: Math.min(open, max), binding: { source, side: "bid", value: bid, net: bid * (1 - (sources[source].sellFee || 0)) } };
  }
  let max = Infinity;
  let open = Infinity;
  let binding = null;
  const limitAt = (net, pct) => Math.floor((net / (1 + pct / 100) / (1 + buyFee)) * 100);
  for (const point of rule.sell) {
    const [source, side] = point.split(":");
    const value = row.prices?.[source]?.[side];
    if (value == null || !sources[source]?.enabled) return null;
    const net = value * (1 - (sources[source].sellFee || 0));
    const limit = limitAt(net, rule.minProfitPercent);
    if (limit < max) {
      max = limit;
      binding = { source, side, value, net };
    }
    open = Math.min(open, limitAt(net, rule.openProfitPercent ?? rule.minProfitPercent));
  }
  return Number.isFinite(max) ? { max, open: Math.min(open, max), binding } : null;
}

function flipAt(priceCents, binding, sources, rule) {
  const buyCost = (priceCents / 100) * (1 + (sources.csfloat?.buyFee || 0));
  const profitUsd = Math.round((binding.net - buyCost) * 100) / 100;
  return {
    sellSource: binding.source,
    sellSide: binding.side,
    sellPrice: Math.round(binding.value * 100) / 100,
    profitUsd,
    profitPercent: Math.round((profitUsd / buyCost) * 10000) / 100,
    rule: ruleLabel(rule),
  };
}

/**
 * Цена барга для лота по правилам cfg.rules — берём правило с самым высоким
 * потолком. Возвращает { offerPrice, maxPrice, ruleIndex, buyNow, flip } или
 * null, если барг не нужен (выгоден по полной цене, а autoBuy выключен) или
 * не поможет (не выгоден даже со скидкой, которую пускает продавец).
 */
function bargainPrice(listing, row, cfg, sources) {
  const listCents = cents(listing.price);
  let best = null;
  cfg.rules.forEach((rule, ruleIndex) => {
    if (rule.disabled) return; // выключено из бота (/rule N off)
    const r = ruleLimits(rule, row, sources, listCents);
    if (r && (!best || r.max > best.max)) best = { ...r, rule, ruleIndex };
  });
  if (!best) return null;

  // Выгоден уже по полной цене — барг не нужен, покупаем сразу (autoBuy).
  const buyNow = best.max >= listCents;
  if (buyNow && !cfg.autoBuy) return null;
  let priceCents = listCents;

  if (!buyNow) {
    const maxDiscountPct =
      listing.maxOfferDiscount != null ? listing.maxOfferDiscount / 100 : cfg.assumedMaxDiscountPercent;
    let lo = Math.ceil(listCents * (1 - maxDiscountPct / 100));
    if (listing.minOfferPrice != null) lo = Math.max(lo, cents(listing.minOfferPrice));
    // Продавец может сразу слить предмет в buy order на CSFloat. Барг не выше
    // него CSFloat помечает как невыгодный ("можно продать дороже") — его не
    // примут, а деньги замёрзнут на 30 мин. Комиссия продавца одна и та же,
    // так что сравниваем цены напрямую.
    const csfloatBid = row.prices?.csfloat?.bid;
    if (csfloatBid != null) lo = Math.max(lo, cents(csfloatBid) + 1);
    if (best.max < lo) return null; // нужна скидка больше, чем пускает продавец
    // Начинаем с открывающей цены, но не ниже того, что продавец вообще пустит.
    priceCents = Math.max(best.open, lo);
  }

  return {
    offerPrice: priceCents / 100,
    maxPrice: best.max / 100,
    ruleIndex: best.ruleIndex,
    buyNow,
    flip: flipAt(priceCents, best.binding, sources, best.rule),
  };
}

function offerIdOf(res) {
  const id = res?.id ?? res?.offer?.id ?? res?.data?.id;
  return id != null ? String(id) : null;
}

const contractIdOf = (o) => String(o?.contract_id ?? o?.contract?.id ?? "");

function createBargainer({ config, notify, getRows = () => [] }) {
  const state = loadState();
  state.counters = state.counters || {};
  const queue = new Map(); // listingId -> candidate
  const errors = new Map(); // key -> { lastSent, suppressed }
  let running = null;
  let mySteamId = null;

  const settings = () => {
    const s = { ...DEFAULTS, ...(config.csfloatAutoBargain || {}), ...state.settings };
    // Раньше 30 мин CSFloat барг не отменит.
    s.ttlMinutes = Math.max(MIN_TTL_MINUTES, Number(s.ttlMinutes) || DEFAULTS.ttlMinutes);
    return s;
  };
  const apiKey = () => process.env.CSFLOAT_API_KEY;

  // Одинаковые ошибки не шлём каждую минуту: первая — сразу, повторы
  // копятся и уходят счётчиком со следующим сообщением той же ошибки.
  async function reportError(key, text) {
    console.error(`[csfloat-bargain] ${text}`);
    const now = Date.now();
    const e = errors.get(key) || { lastSent: 0, suppressed: 0 };
    if (now - e.lastSent < ERROR_REPEAT_MS) {
      e.suppressed++;
      errors.set(key, e);
      return;
    }
    const extra = e.suppressed ? ` (+${e.suppressed} таких же за ${Math.round((now - e.lastSent) / 60000)} мин)` : "";
    errors.set(key, { lastSent: now, suppressed: 0 });
    await notify(`⚠️ Автобарг: ${text}${extra}`).catch(() => {});
  }

  function openOffers() {
    return Object.entries(state.offers).filter(([, o]) => o.state === "active");
  }

  function openSumCents() {
    return openOffers().reduce((s, [, o]) => s + cents(o.price), 0);
  }

  /** Сколько можно потратить на новый барг прямо сейчас (в центах). */
  async function freeCents(cfg) {
    const { available } = await fetchBalance(apiKey());
    const reserved = state.reservesBalance === true ? 0 : openSumCents();
    return { balanceCents: cents(available), free: cents(available) - reserved - cents(cfg.reserveUsd) };
  }

  /** Потолок цены для нашего барга сейчас: по свежим ценам, если они есть. */
  function currentMaxCents(o, cfg) {
    const rule = o.ruleIndex != null ? cfg.rules[o.ruleIndex] : null;
    const row = getRows().find((r) => r.marketHashName === (o.rowKey || o.name));
    if (rule && row) {
      const r = ruleLimits(rule, row, config.sources, cents(o.listPrice));
      if (r) return r.max;
    }
    // Старые записи без правила — не выше того, что сами предлагали.
    return cents(o.maxPrice ?? o.price);
  }

  // ---- 1. Что стало с нашими баргами ----
  async function syncOffers(cfg) {
    const live = openOffers().filter(([, o]) => !o.dryRun);
    if (!live.length) return;
    let list;
    try {
      const data = await api(apiKey(), "GET", "/me/offers-timeline?limit=100");
      list = Array.isArray(data) ? data : data?.offers || data?.data || [];
    } catch (err) {
      await reportError("timeline", `не прочитал свои барги: ${err.message}`);
      return;
    }
    const byId = new Map(list.map((o) => [String(o.id), o]));
    for (const [id, o] of live) {
      // Контр-оффер продавца — новое предложение по тому же лоту, которого
      // мы не отправляли. Наш барг он закрывает, отменять его уже нечего.
      const counter = list
        .filter(
          (x) =>
            contractIdOf(x) === String(o.listingId) &&
            !state.offers[String(x.id)] &&
            !state.counters[String(x.id)] &&
            (!x.state || x.state === "active") &&
            !(Date.parse(x.created_at) < Date.parse(o.sentAt) - 5 * 60 * 1000)
        )
        .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0))[0];
      if (counter) {
        await answerCounter(id, o, counter, cfg);
        saveState(state);
        continue;
      }

      const remote = byId.get(id);
      o.remoteMissing = !remote;
      if (!remote?.state || remote.state === "active") continue;
      o.state = remote.state;
      o.closedAt = new Date().toISOString();
      if (remote.state === "accepted") {
        await notify(`✅ Барг принят: <b>${o.name}</b> за $${usd(cents(o.price))} (лот $${usd(cents(o.listPrice))}). Ожидаемый профит $${o.profitUsd}.\n${o.url}`).catch(() => {});
      } else {
        await notify(`↩️ Барг закрыт (${remote.state}): ${o.name} $${usd(cents(o.price))}`).catch(() => {});
      }
    }
  }

  // ---- 1b. Ответ на контр-оффер продавца ----
  async function answerCounter(ourId, o, counter, cfg) {
    const counterId = String(counter.id);
    const now = new Date().toISOString();
    const counterCents = Math.round(Number(counter.price));
    state.counters[counterId] = now;
    Object.assign(o, { state: "countered", closedAt: now, counterId, counterPrice: counterCents / 100 });

    const maxCents = currentMaxCents(o, cfg);
    const head = `<b>${o.name}</b>: наш барг $${usd(cents(o.price))}, продавец ответил $${usd(counterCents)} (лот $${usd(cents(o.listPrice))}, наш потолок $${usd(maxCents)})`;

    if (!Number.isFinite(counterCents) || counterCents <= 0) {
      await reportError("counter-price", `контр-оффер ${counterId} без цены — ${o.name}: ${JSON.stringify(counter).slice(0, 160)}`);
      return;
    }
    if (!cfg.answerCounters || !cfg.enabled) {
      await notify(`💬 Контр-оффер: ${head}\nОтвечать на контры выключено — реши сам.\n${o.url}`).catch(() => {});
      return;
    }

    if (counterCents <= maxCents) {
      let budget;
      try {
        budget = await freeCents(cfg);
      } catch (err) {
        await reportError("balance", `не прочитал баланс для контра: ${err.message}`);
        return;
      }
      if (counterCents > budget.free) {
        await notify(`💰 Контр-оффер подходит, но денег сверх резерва не хватает (свободно $${usd(Math.max(0, budget.free))}): ${head}\n${o.url}`).catch(() => {});
        return;
      }
      try {
        await api(apiKey(), "POST", `/offers/${counterId}/accept`, {});
        state.buys = state.buys || {};
        state.buys[o.listingId] = { ...o, price: counterCents / 100, state: "bought", boughtAt: now };
        await notify(`✅ Принял контр-оффер: ${head}\n${o.url}`).catch(() => {});
      } catch (err) {
        await reportError(`counter-accept:${err.status || "x"}`, `не принял контр-оффер (${o.name}, $${usd(counterCents)}): ${err.message}`);
      }
      return;
    }

    if (maxCents > cents(o.price)) {
      let res;
      try {
        res = await api(apiKey(), "POST", `/offers/${counterId}/counter-offer`, { price: maxCents });
      } catch (err) {
        // Нет такого эндпоинта — новый барг по лоту тоже отвечает продавцу.
        if (![404, 405].includes(err.status)) {
          await reportError(`counter-send:${err.status || "x"}`, `не ответил контром (${o.name}, $${usd(maxCents)}): ${err.message}`);
          return;
        }
        try {
          res = await api(apiKey(), "POST", "/offers", { contract_id: o.listingId, price: maxCents, cancel_previous_offer: true });
        } catch (err2) {
          await reportError(`counter-send:${err2.status || "x"}`, `не ответил контром (${o.name}, $${usd(maxCents)}): ${err2.message}`);
          return;
        }
      }
      const id = offerIdOf(res);
      if (!id) {
        await reportError("counter-id", `CSFloat не вернул id контра (${o.name}): ${JSON.stringify(res).slice(0, 160)}`);
        return;
      }
      const { counterId: _c, counterPrice: _p, closedAt: _x, remoteMissing: _m, ...base } = o;
      state.offers[id] = { ...base, price: maxCents / 100, sentAt: now, state: "active", round: (o.round || 1) + 1, inReplyTo: counterId };
      await notify(`↪️ Ответил контром $${usd(maxCents)} (наш потолок): ${head}\n${o.url}`).catch(() => {});
      return;
    }

    await notify(`🚫 Контр-оффер выше нашего потолка — не отвечаю, предложение продавца истечёт само: ${head}\n${o.url}`).catch(() => {});
  }

  // ---- 2. Отмена баргов без ответа ----
  async function cancelExpired(cfg) {
    const ttlMs = cfg.ttlMinutes * 60 * 1000;
    for (const [id, o] of openOffers()) {
      if (Date.now() - Date.parse(o.sentAt) < ttlMs) continue;
      if (o.dryRun) {
        o.state = "cancelled";
        continue;
      }
      try {
        await api(apiKey(), "DELETE", `/offers/${id}`);
        o.state = "cancelled";
        o.closedAt = new Date().toISOString();
        await notify(`⏱ Барг без ответа ${cfg.ttlMinutes} мин — отменил: ${o.name} $${usd(cents(o.price))}`).catch(() => {});
      } catch (err) {
        // 404 / уже не активен — барг закрылся сам (принят, отклонён или его
        // закрыл контр-оффер), следующий syncOffers это увидит. Если в ленте
        // его нет вовсе, а CSFloat отвечает "нельзя" — он уже не активен.
        // Первые минуты после 30-й CSFloat может ещё считать, что рано
        // (разница часов) — тогда тихо пробуем на следующем тике.
        // 409 "you can only cancel active offers" — CSFloat прямо говорит, что
        // барг уже не активен (так бывает после контр-оффера продавца).
        if (err.status === 404 || err.status === 409 || (o.remoteMissing && [400, 422].includes(err.status))) {
          o.state = "gone";
          o.closedAt = new Date().toISOString();
          await notify(`↩️ Барг уже не активен на CSFloat — снял с учёта: ${o.name} $${usd(cents(o.price))}`).catch(() => {});
        } else if (Date.now() - Date.parse(o.sentAt) < ttlMs + 3 * 60 * 1000) {
          console.warn(`[csfloat-bargain] отмена ${id} не прошла, повторю: ${err.message}`);
        } else {
          await reportError("cancel", `не отменил барг ${o.name} (${id}): ${err.message}`);
        }
      }
      await sleep(CALL_GAP_MS);
    }
  }

  // ---- 3. Отправка новых баргов из очереди ----
  /**
   * Другие лоты того же предмета не дороже priceCents (для покупки — строго
   * дешевле), от дешёвых к дорогим. Доплеры — по paint_index фазы: у всех
   * фаз один market_hash_name.
   */
  async function cheaperLots(c, priceCents) {
    const limit = c.buyNow ? priceCents - 1 : priceCents;
    const qs = new URLSearchParams({ limit: "10", sort_by: "lowest_price", type: "buy_now", market_hash_name: c.listing.name, max_price: String(limit) });
    const paint = paintIndexFor(c.listing.name, c.listing.phase);
    if (paint) qs.set("paint_index", String(paint));
    const res = await api(apiKey(), "GET", `/listings?${qs}`);
    const list = Array.isArray(res) ? res : res?.data || [];
    return list
      .filter((l) => String(l.id) !== String(c.listing.id))
      .filter((l) => !(mySteamId && String(l.seller?.steam_id) === String(mySteamId)))
      .map(normalizeListing)
      .filter((l) => l.rowKey === c.listing.rowKey && cents(l.price) <= limit)
      .sort((a, b) => a.price - b.price);
  }

  async function sendFromQueue(cfg) {
    const now = Date.now();
    for (const [lid, c] of queue) {
      if (now - c.queuedAt > cfg.queueMinutes * 60 * 1000) queue.delete(lid);
    }
    if (!queue.size) return;

    let budget;
    try {
      budget = await freeCents(cfg);
    } catch (err) {
      await reportError("balance", `не прочитал баланс: ${err.message}`);
      return;
    }

    // Покупки по полной цене — первыми (их перехватят быстрее всего), дальше по профиту.
    const ordered = [...queue.values()].sort(
      (a, b) => Number(!!b.buyNow) - Number(!!a.buyNow) || b.flip.profitUsd - a.flip.profitUsd
    );
    for (const c of ordered) {
      const price = cents(c.offerPrice);
      if (price > budget.free) continue; // дорогой — ждёт, пока освободятся деньги; дешевле может влезть
      queue.delete(c.listing.id);
      state.tried[c.listing.id] = new Date().toISOString();

      // Лот ещё висит и по той же цене?
      try {
        const live = await api(apiKey(), "GET", `/listings/${c.listing.id}`);
        if (live?.state && live.state !== "listed") continue;
        if (Number.isFinite(Number(live?.price)) && Math.round(Number(live.price)) !== cents(c.listing.price)) continue;
        const sellerId = live?.seller?.steam_id;
        if (mySteamId && sellerId && String(sellerId) === String(mySteamId)) continue;
      } catch (err) {
        if (err.status === 404) continue;
        await reportError("listing", `не проверил лот ${c.listing.id}: ${err.message}`);
        continue;
      }

      // Тот же предмет (с той же фазой) уже лежит на рынке не дороже нашего
      // барга — барговать этот лот глупо: дешевле просто взять тот. Тот лот
      // сами ставим в очередь — если он проходит по правилам, купим/побаргуем его.
      try {
        await sleep(CALL_GAP_MS);
        const cheaper = await cheaperLots(c, price);
        if (cheaper.length) {
          const best = cheaper[0];
          console.log(
            `[csfloat-bargain] пропустил ${c.row.marketHashName} (лот ${c.listing.id}, ${c.buyNow ? "покупка" : "барг"} $${usd(price)}): на рынке есть за $${best.price.toFixed(2)} (${best.id})`
          );
          for (const l of cheaper) {
            if (state.tried[l.id] || queue.has(l.id)) continue;
            const bp = bargainPrice(l, c.row, cfg, config.sources);
            if (bp) queue.set(l.id, { listing: l, row: c.row, ...bp, queuedAt: Date.now() });
          }
          continue;
        }
      } catch (err) {
        // Не проверили — не рискуем: лучше пропустить лот, чем переплатить.
        await reportError(`cheaper:${err.status || "x"}`, `не проверил, нет ли ${c.row.marketHashName} дешевле: ${err.message}`);
        continue;
      }

      const record = {
        listingId: c.listing.id,
        url: c.listing.url,
        name: c.row.marketHashName,
        rowKey: c.row.marketHashName,
        price: c.offerPrice,
        maxPrice: c.maxPrice,
        ruleIndex: c.ruleIndex,
        listPrice: c.listing.price,
        sellSource: c.flip.sellSource,
        sellPrice: c.flip.sellPrice,
        profitUsd: c.flip.profitUsd,
        profitPercent: c.flip.profitPercent,
        sentAt: new Date().toISOString(),
        state: "active",
        round: 1,
      };
      record.rule = c.flip.rule;
      const room = !c.buyNow && c.maxPrice > c.offerPrice ? `, торгуюсь до $${c.maxPrice.toFixed(2)}` : "";
      const deal = `${record.rule}; ${record.sellSource} bid $${record.sellPrice}, профит $${record.profitUsd} / ${record.profitPercent}%${room}`;

      if (c.buyNow) {
        const buyLine = `<b>${record.name}</b> за $${usd(price)} без барга (${deal})\n${record.url}`;
        if (cfg.dryRun) {
          budget.free -= price;
          await notify(`🧪 Тест, не куплено: ${buyLine}`).catch(() => {});
          continue;
        }
        try {
          await api(apiKey(), "POST", "/listings/buy", { total_price: price, contract_ids: [c.listing.id] });
          budget.free -= price;
          budget.balanceCents -= price;
          state.buys = state.buys || {};
          state.buys[c.listing.id] = { ...record, state: "bought", boughtAt: record.sentAt };
          await notify(`🛒 Купил: ${buyLine}`).catch(() => {});
        } catch (err) {
          await reportError(`buy:${err.status || "x"}`, `не купил ${record.name} за $${usd(price)}: ${err.message}`);
        }
        saveState(state);
        await sleep(CALL_GAP_MS);
        continue;
      }

      const line = `<b>${record.name}</b>: лот $${usd(cents(record.listPrice))} → барг $${usd(price)} (${deal})\n${record.url}`;

      if (cfg.dryRun) {
        record.dryRun = true;
        state.offers[`dry-${c.listing.id}`] = record;
        budget.free -= price;
        await notify(`🧪 Тест, не отправлено: ${line}`).catch(() => {});
        continue;
      }

      try {
        const res = await api(apiKey(), "POST", "/offers", {
          contract_id: c.listing.id,
          price,
          cancel_previous_offer: false,
        });
        const id = offerIdOf(res);
        if (!id) throw new Error(`CSFloat не вернул id барга: ${JSON.stringify(res).slice(0, 160)}`);
        state.offers[id] = record;
        budget.free -= price;
        await notify(`💸 Отправил барг: ${line}`).catch(() => {});

        // Узнаём один раз, держит ли CSFloat деньги под барг.
        if (state.reservesBalance == null) {
          await sleep(CALL_GAP_MS);
          const after = await fetchBalance(apiKey()).catch(() => null);
          if (after) {
            const drop = budget.balanceCents - cents(after.available);
            if (Math.abs(drop - price) <= 1) state.reservesBalance = true;
            else if (drop === 0) state.reservesBalance = false;
            if (state.reservesBalance != null) {
              console.log(`[csfloat-bargain] balance в /me ${state.reservesBalance ? "уже без" : "включает"} замороженного под барги`);
              // Дальше бюджет считаем по новому правилу.
              budget = await freeCents(cfg).catch(() => budget);
            }
          }
        }
      } catch (err) {
        await reportError(`send:${err.status || "x"}`, `барг не отправился (${record.name}, $${usd(price)}): ${err.message}`);
      }
      saveState(state);
      await sleep(CALL_GAP_MS);
    }
  }

  function pruneState() {
    const day = 24 * 60 * 60 * 1000;
    for (const [id, at] of Object.entries(state.tried)) {
      if (Date.now() - Date.parse(at) > day) delete state.tried[id];
    }
    for (const [id, at] of Object.entries(state.counters)) {
      if (Date.now() - Date.parse(at) > 7 * day) delete state.counters[id];
    }
    for (const [id, b] of Object.entries(state.buys || {})) {
      if (Date.now() - Date.parse(b.boughtAt) > 7 * day) delete state.buys[id];
    }
    for (const [id, o] of Object.entries(state.offers)) {
      if (o.state !== "active" && Date.now() - Date.parse(o.closedAt || o.sentAt) > 7 * day) delete state.offers[id];
    }
  }

  async function tickOnce() {
    const cfg = settings();
    if (!apiKey()) return;
    if (!mySteamId) {
      mySteamId = await api(apiKey(), "GET", "/me")
        .then((me) => me?.user?.steam_id || null)
        .catch(() => null);
    }
    await syncOffers(cfg);
    // Отменяем просроченные даже при выключенных баргах — деньги не должны висеть.
    await cancelExpired(cfg);
    if (cfg.enabled) await sendFromQueue(cfg);
    else queue.clear();
    pruneState();
    saveState(state);
  }

  // Один проход за раз: новые лоты и таймер не должны отправлять параллельно.
  function tick() {
    if (!running) {
      running = tickOnce()
        .catch((err) => reportError("tick", err.message))
        .finally(() => {
          running = null;
        });
    }
    return running;
  }

  /** Новые кандидаты из live-ленты: [{ listing, row, offerPrice, maxPrice, ruleIndex, buyNow, flip }]. */
  function consider(candidates) {
    const cfg = settings();
    if (!cfg.enabled) return;
    for (const c of candidates) {
      if (state.tried[c.listing.id] || queue.has(c.listing.id)) continue;
      queue.set(c.listing.id, { ...c, queuedAt: Date.now() });
    }
    // Лишнее — самые невыгодные.
    if (queue.size > cfg.maxQueue) {
      const worst = [...queue.values()].sort((a, b) => a.flip.profitUsd - b.flip.profitUsd);
      for (const c of worst.slice(0, queue.size - cfg.maxQueue)) queue.delete(c.listing.id);
    }
    if (candidates.length) tick();
  }

  function setSetting(key, value) {
    state.settings[key] = value;
    saveState(state);
  }

  /** Убрать настройку из бота — снова действует config.json. */
  function resetSetting(key) {
    delete state.settings[key];
    saveState(state);
  }

  function statusText() {
    const cfg = settings();
    const open = openOffers();
    const lines = [
      "🤝 <b>Автобарги CSFloat</b>",
      `Статус: ${cfg.enabled ? (cfg.dryRun ? "включены, ТЕСТ (ничего не отправляю)" : "включены") : "выключены"}`,
      `Правила${state.settings.rules ? " (из бота)" : ""}: ${cfg.rules.filter((r) => !r.disabled).map(ruleLabel).join("  или  ") || "все выключены"}`,
      `Покупка без барга, если лот проходит правила по полной цене: ${cfg.autoBuy ? "да" : "нет"}`,
      `Отвечать на контр-офферы: ${cfg.answerCounters ? "да (принять до потолка / контр по потолку)" : "нет"}`,
      `Резерв на балансе: $${cfg.reserveUsd}`,
      `Отмена без ответа через: ${cfg.ttlMinutes} мин`,
      `Скидка, если лот её не сообщает: до ${cfg.assumedMaxDiscountPercent}%`,
      `Баланс в /me уже без замороженного под барги: ${state.reservesBalance == null ? "узнаю после первого барга (пока вычитаю висящие сам)" : state.reservesBalance ? "да" : "нет (вычитаю висящие сам)"}`,
      `Висит баргов: ${open.length} на $${usd(openSumCents())}`,
      `В очереди ждут денег: ${queue.size}`,
    ];
    for (const [, o] of open.slice(0, 10)) {
      const left = Math.max(0, Math.round((Date.parse(o.sentAt) + cfg.ttlMinutes * 60000 - Date.now()) / 60000));
      lines.push(`• ${o.name} $${usd(cents(o.price))}${o.round > 1 ? " (контр)" : ""} (ещё ${left} мин)`);
    }
    return lines.join("\n");
  }

  function start() {
    setInterval(tick, TICK_MS);
    tick();
  }

  return {
    consider,
    tick,
    start,
    settings,
    setSetting,
    resetSetting,
    isOverridden: (key) => Object.prototype.hasOwnProperty.call(state.settings, key),
    statusText,
    bargainPrice: (listing, row) => bargainPrice(listing, row, settings(), config.sources),
  };
}

module.exports = { createBargainer, bargainPrice, ruleLimits, ruleLabel, DEFAULTS };
