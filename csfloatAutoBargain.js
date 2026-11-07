// Автобарги на CSFloat по лотам из live-ленты бота арбитража (telegramArbBot.js).
//
// Бот каждые 30 с берёт новые лоты CSFloat. Лот, который НЕ выгоден по полной
// цене, но стал бы выгоден по цене в пределах разрешённой скидки продавца,
// попадает сюда: цена барга = самая высокая цена, при которой чистый профит
// ещё не ниже порога правил (rules ниже: 7% под Youpin bid и Skinbux сразу,
// или 10% под один Skinbux). Из фильтров владельца в боте берутся только
// исключения и диапазон цен (/status), не связка и не мин. профит.
//
// Деньги:
//   - всегда оставляем reserveUsd (по умолчанию $1000) на балансе;
//   - висящий барг замораживает деньги, поэтому через ttlMinutes (30) без
//     ответа барг отменяем, а освободившиеся деньги идут на следующий лот из
//     очереди (самый выгодный, ещё не протухший).
//
// CSFloat замораживает сумму барга до 24 ч; отменить барг можно не раньше
// чем через 30 мин — тогда деньги сразу снова доступны. Поэтому ttlMinutes
// не меньше 30. Не известно только, показывает ли поле balance в /me уже
// за вычетом замороженного. Пока не узнали — считаем осторожно: balance минус
// сумма наших висящих баргов. После первого барга сравниваем баланс до и
// после и запоминаем ответ (reservesBalance в csfloatAutoBargains.json).
//
// Эндпоинты взяты из открытых клиентов (официальной документации нет):
//   POST   /offers {contract_id, price, cancel_previous_offer}
//   GET    /me/offers-timeline?limit=N
//   DELETE /offers/:id  — отмена (в клиентах не описана, проверяем вживую;
//                          если CSFloat её не примет — ошибка придёт в Telegram)
const fs = require("fs");
const path = require("path");
const { api } = require("./csfloatAutoList");
const { fetchBalance } = require("./csfloatAccount");

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
  // Кандидат ждёт денег в очереди не дольше этого — потом лот уже купили.
  queueMinutes: 15,
  maxQueue: 50,
  // Под что покупаем. Правило выполняется, если чистый профит (после
  // комиссий) не ниже minProfitPercent против КАЖДОЙ площадки из sell.
  // Из правил берётся то, что даёт самую высокую цену барга.
  rules: [
    { sell: ["youpin:bid", "skinbux:bid"], minProfitPercent: 7 },
    { sell: ["skinbux:bid"], minProfitPercent: 10 },
    // Youpin ask − 7%, если Youpin bid не ниже этой цены и лот выставлен не
    // дороже 96% от Youpin ask (лоты "по рынку Youpin" на −7% не уступят).
    { fromAsk: "youpin:ask", discountPercent: 7, maxListPercentOfAsk: 96 },
  ],
};

function ruleLabel(rule) {
  return rule.fromAsk
    ? `${rule.fromAsk} −${rule.discountPercent}% (bid не ниже${rule.maxListPercentOfAsk ? `, лот ≤ ${rule.maxListPercentOfAsk}% ask` : ""})`
    : `${rule.minProfitPercent}% под ${rule.sell.join(" + ")}`;
}
const MIN_TTL_MINUTES = 30;
const TICK_MS = 60 * 1000;
const CALL_GAP_MS = 1200;
const ERROR_REPEAT_MS = 15 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cents = (usd) => Math.round(usd * 100);
const usd = (c) => (Math.round(c) / 100).toFixed(2);

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { settings: {}, offers: {}, tried: {}, reservesBalance: null, ...s };
  } catch {
    return { settings: {}, offers: {}, tried: {}, reservesBalance: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Самая высокая цена покупки (в центах), при которой правило выполняется:
 * чистый профит не ниже minProfitPercent против КАЖДОЙ площадки правила
 * (после комиссий из config.sources). Нет цены у какой-то площадки — правило
 * не подходит.
 */
function maxBuyCents(rule, row, sources, listCents) {
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
    const price = Math.floor(ask * (1 - rule.discountPercent / 100) * 100);
    if (Math.round(bid * 100) < price) return null;
    return { cents: price, binding: { source, side: "bid", value: bid, net: bid * (1 - (sources[source].sellFee || 0)) } };
  }
  let max = Infinity;
  let binding = null;
  for (const point of rule.sell) {
    const [source, side] = point.split(":");
    const value = row.prices?.[source]?.[side];
    if (value == null || !sources[source]?.enabled) return null;
    const net = value * (1 - (sources[source].sellFee || 0));
    const limit = Math.floor((net / (1 + rule.minProfitPercent / 100) / (1 + buyFee)) * 100);
    if (limit < max) {
      max = limit;
      binding = { source, side, value, net };
    }
  }
  return Number.isFinite(max) ? { cents: max, binding } : null;
}

/**
 * Цена барга для лота по правилам cfg.rules (по умолчанию: 7% под Youpin bid
 * И Skinbux одновременно, либо 10% под один Skinbux — берём то, что даёт
 * цену выше). Возвращает { offerPrice, flip } или null, если барг не нужен
 * (выгоден и по полной цене) или не поможет (не выгоден даже со скидкой).
 */
function bargainPrice(listing, row, cfg, sources) {
  const listCents = cents(listing.price);
  let best = null;
  for (const rule of cfg.rules) {
    const r = maxBuyCents(rule, row, sources, listCents);
    if (r && (!best || r.cents > best.cents)) best = { ...r, rule };
  }
  if (!best) return null;

  // Выгоден уже по полной цене — барг не нужен, покупаем сразу (autoBuy).
  const buyNow = best.cents >= listCents;
  if (buyNow && !cfg.autoBuy) return null;
  const priceCents = buyNow ? listCents : best.cents;

  if (!buyNow) {
    // Продавец может сразу слить предмет в buy order на CSFloat. Барг не выше
    // него CSFloat помечает как невыгодный ("можно продать дороже") — его не
    // примут, а деньги замёрзнут на 30 мин. Комиссия продавца одна и та же,
    // так что сравниваем цены напрямую.
    const csfloatBid = row.prices?.csfloat?.bid;
    if (csfloatBid != null && best.cents <= cents(csfloatBid)) return null;

    const maxDiscountPct =
      listing.maxOfferDiscount != null ? listing.maxOfferDiscount / 100 : cfg.assumedMaxDiscountPercent;
    let lo = Math.ceil(listCents * (1 - maxDiscountPct / 100));
    if (listing.minOfferPrice != null) lo = Math.max(lo, cents(listing.minOfferPrice));
    if (best.cents < lo) return null; // нужна скидка больше, чем пускает продавец
  }

  const buyCost = (priceCents / 100) * (1 + (sources.csfloat?.buyFee || 0));
  const profitUsd = Math.round((best.binding.net - buyCost) * 100) / 100;
  return {
    offerPrice: priceCents / 100,
    buyNow,
    flip: {
      sellSource: best.binding.source,
      sellSide: best.binding.side,
      sellPrice: Math.round(best.binding.value * 100) / 100,
      profitUsd,
      profitPercent: Math.round((profitUsd / buyCost) * 10000) / 100,
      rule: ruleLabel(best.rule),
    },
  };
}

function offerIdOf(res) {
  const id = res?.id ?? res?.offer?.id ?? res?.data?.id;
  return id != null ? String(id) : null;
}

function createBargainer({ config, notify }) {
  const state = loadState();
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

  // ---- 1. Что стало с нашими баргами ----
  async function syncOffers() {
    if (!openOffers().length) return;
    let list;
    try {
      const data = await api(apiKey(), "GET", "/me/offers-timeline?limit=100");
      list = Array.isArray(data) ? data : data?.offers || data?.data || [];
    } catch (err) {
      await reportError("timeline", `не прочитал свои барги: ${err.message}`);
      return;
    }
    const byId = new Map(list.map((o) => [String(o.id), o]));
    for (const [id, o] of openOffers()) {
      const remote = byId.get(id);
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
        // 404 / уже не активен — барг закрылся сам (принят или отклонён),
        // следующий syncOffers это увидит. Остальное — в Telegram.
        // Первые минуты после 30-й CSFloat может ещё считать, что рано
        // (разница часов) — тогда тихо пробуем на следующем тике.
        if (err.status === 404) o.state = "gone";
        else if (Date.now() - Date.parse(o.sentAt) < ttlMs + 3 * 60 * 1000) console.warn(`[csfloat-bargain] отмена ${id} не прошла, повторю: ${err.message}`);
        else await reportError("cancel", `не отменил барг ${o.name} (${id}): ${err.message}`);
      }
      await sleep(CALL_GAP_MS);
    }
  }

  // ---- 3. Отправка новых баргов из очереди ----
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

      const record = {
        listingId: c.listing.id,
        url: c.listing.url,
        name: c.row.marketHashName,
        price: c.offerPrice,
        listPrice: c.listing.price,
        sellSource: c.flip.sellSource,
        sellPrice: c.flip.sellPrice,
        profitUsd: c.flip.profitUsd,
        profitPercent: c.flip.profitPercent,
        sentAt: new Date().toISOString(),
        state: "active",
      };
      record.rule = c.flip.rule;
      const deal = `${record.rule}; ${record.sellSource} bid $${record.sellPrice}, профит $${record.profitUsd} / ${record.profitPercent}%`;

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
    await syncOffers();
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

  /** Новые кандидаты из live-ленты: [{ listing, row, offerPrice, flip }]. */
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

  function statusText() {
    const cfg = settings();
    const open = openOffers();
    const lines = [
      "🤝 <b>Автобарги CSFloat</b>",
      `Статус: ${cfg.enabled ? (cfg.dryRun ? "включены, ТЕСТ (ничего не отправляю)" : "включены") : "выключены"}`,
      `Правила: ${cfg.rules.map(ruleLabel).join("  или  ")}`,
      `Покупка без барга, если лот проходит правила по полной цене: ${cfg.autoBuy ? "да" : "нет"}`,
      `Резерв на балансе: $${cfg.reserveUsd}`,
      `Отмена без ответа через: ${cfg.ttlMinutes} мин`,
      `Скидка, если лот её не сообщает: до ${cfg.assumedMaxDiscountPercent}%`,
      `Баланс в /me уже без замороженного под барги: ${state.reservesBalance == null ? "узнаю после первого барга (пока вычитаю висящие сам)" : state.reservesBalance ? "да" : "нет (вычитаю висящие сам)"}`,
      `Висит баргов: ${open.length} на $${usd(openSumCents())}`,
      `В очереди ждут денег: ${queue.size}`,
    ];
    for (const [, o] of open.slice(0, 10)) {
      const left = Math.max(0, Math.round((Date.parse(o.sentAt) + cfg.ttlMinutes * 60000 - Date.now()) / 60000));
      lines.push(`• ${o.name} $${usd(cents(o.price))} (ещё ${left} мин)`);
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
    statusText,
    bargainPrice: (listing, row) => bargainPrice(listing, row, settings(), config.sources),
  };
}

module.exports = { createBargainer, bargainPrice, DEFAULTS };
