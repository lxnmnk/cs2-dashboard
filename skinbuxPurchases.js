// Покупка скіна клієнтом із вітрини Skinbux за баланс на сайті.
//
// Як це працює:
//   1. Клієнт тисне "Купити" на конкретному лоті (float, Instant/P2P).
//   2. Беремо свіжий стан лота у Skinbux (ціна могла змінитись, лот — зникнути).
//      Ціна клієнту = ціна Skinbux + наша націнка (buyMarkup з панелі). Якщо
//      вона вища за ту, що клієнт бачив, — не купуємо, показуємо нову.
//   3. Платить клієнт своїм балансом на сайті: спершу "trade" (гроші під
//      обмін), потім "available". "hold" не чіпаємо — його ще немає.
//   4. Записуємо покупку (status pending) — з цієї миті сума вже не входить у
//      баланс клієнта, тож двічі її не витратити.
//   5. POST /v1/transaction/buy з trade-посиланням клієнта: Skinbux списує
//      гроші з нашого мерчант-балансу і сам шле клієнту трейд.
//   6. sync() раз на хвилину питає статус: completed — готово; cancelled /
//      reverted — трейд не відбувся, Skinbux повернув гроші нам, а ми
//      повертаємо клієнту (status refunded — сума знову в балансі).
//
// Мережева помилка на кроці 5 — невідомо, купилось чи ні. Тоді не повертаємо
// гроші одразу (status unknown), а шукаємо транзакцію за нашим externalId; не
// знайшлась за 10 хв — значить, не купилось (failed).
//
// Файл skinbuxPurchases.json — живі дані, на сервер поверх не заливати.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const market = require("./skinbuxMarket");

const FILE = path.join(__dirname, "skinbuxPurchases.json");
const BASE = "https://api.skinbux.com/v1";
const UNKNOWN_GIVE_UP_MS = 10 * 60 * 1000;
// Статуси, у яких гроші клієнта вважаються витраченими.
const SPENT = new Set(["pending", "sent", "completed", "unknown", "mixed"]);
const REFUND_STATUSES = new Set(["cancelled", "reverted"]);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function loadAll() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveAll(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

function update(id, patch) {
  const all = loadAll();
  const p = all.find((x) => x.id === id);
  if (!p) return null;
  Object.assign(p, patch, { updatedAt: new Date().toISOString() });
  saveAll(all);
  return p;
}

/** Скільки клієнт уже витратив на покупки — по гаманцях. */
function spentFor(steamId) {
  const out = { available: 0, trade: 0 };
  for (const p of loadAll()) {
    if (p.steamId !== String(steamId) || !SPENT.has(p.status)) continue;
    out.available = round2(out.available + (p.paid?.available || 0));
    out.trade = round2(out.trade + (p.paid?.trade || 0));
  }
  return out;
}

/** Баланс клієнта мінус покупки. Підставляти скрізь, де клієнт бачить баланс. */
function applyTo(balance, steamId) {
  const spent = spentFor(steamId);
  return {
    ...balance,
    available: round2((balance.available || 0) - spent.available),
    trade: round2((balance.trade || 0) - spent.trade),
  };
}

function listByUser(steamId) {
  return loadAll()
    .filter((p) => p.steamId === String(steamId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

class BuyError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

// Одна покупка за раз: перевірка балансу і запис мають іти без чужих покупок
// між ними, інакше два кліки поспіль витратили б ту саму суму двічі.
let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function skinbuxBuy(apiKey, body) {
  const res = await fetch(`${BASE}/transaction/buy`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    // Відповідь є — значить, Skinbux точно не купив.
    const err = new BuyError("SKINBUX_REJECTED", data?.error?.message || `Skinbux ${res.status}`);
    err.skinbuxCode = data?.error?.code ?? null;
    err.definite = true;
    throw err;
  }
  return data.data;
}

/**
 * Купити лот для клієнта.
 * getBalance(steamId) -> { available, hold, trade } уже з поправками і покупками.
 * Повертає запис покупки; кидає BuyError з code для відповіді клієнту.
 */
function buy({ steamId, tradeUrl, recipientSteamId = null, recipientName = null, stackId, listingId, expectedPrice, markup, getBalance, isAllowed = () => true, notify = async () => {} }) {
  return exclusive(async () => {
    const apiKey = process.env.SKINBUX_API_KEY;
    if (!apiKey) throw new BuyError("NOT_CONFIGURED", "SKINBUX_API_KEY не задан");
    if (!tradeUrl) throw new BuyError("NO_TRADE_URL", "no trade url");

    const live = await market.freshListing(stackId, listingId);
    if (!live) throw new BuyError("ITEM_GONE", "listing is gone");
    const listing = market.normalizeListing(live, markup);
    if (!(listing.skinbuxCents > 0)) throw new BuyError("ITEM_GONE", "no price");
    // Та сама перевірка, що на вітрині: лот за ціною без ринку (наліпка за
    // $148 000) не продаємо, навіть якщо хтось дістукався до нього напряму.
    if (!isAllowed(live, listing.price)) throw new BuyError("ITEM_GONE", "price out of market");
    if (Number.isFinite(expectedPrice) && listing.price > expectedPrice + 0.009) {
      throw new BuyError("PRICE_CHANGED", "price changed", { price: listing.price });
    }

    const balance = getBalance(steamId);
    const fromTrade = round2(Math.min(Math.max(0, balance.trade || 0), listing.price));
    const fromAvailable = round2(listing.price - fromTrade);
    if (fromAvailable > round2(Math.max(0, balance.available || 0)) + 0.001) {
      throw new BuyError("INSUFFICIENT_BALANCE", "not enough balance", {
        price: listing.price,
        balance: round2(Math.max(0, balance.available || 0) + Math.max(0, balance.trade || 0)),
      });
    }

    const now = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(),
      steamId: String(steamId),
      stackId,
      listingId: String(listingId),
      name: live.name,
      float: listing.float,
      pattern: listing.pattern,
      delivery: listing.delivery,
      price: listing.price,
      skinbuxCents: listing.skinbuxCents,
      paid: { trade: fromTrade, available: fromAvailable },
      tradeUrl,
      ...(recipientSteamId ? { recipientSteamId: String(recipientSteamId), recipientName } : {}),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    const all = loadAll();
    all.push(record);
    saveAll(all);

    try {
      const res = await skinbuxBuy(apiKey, {
        id: String(listingId),
        price: listing.skinbuxCents,
        tradeUrl,
        externalId: `gm-${record.id}`,
      });
      const saved = update(record.id, { status: "sent", skinbuxId: res?.id ?? null, expiresAt: res?.expiresAt ?? null });
      notify(
        `🛒 Клиент купил с сайта: ${record.name}` +
          (record.float != null ? ` (float ${record.float.toFixed(6)})` : "") +
          `\n${record.delivery === "instant" ? "Instant" : "P2P"} · клиенту $${record.price.toFixed(2)}, Skinbux $${(record.skinbuxCents / 100).toFixed(2)}` +
          `\nSteam ID ${record.steamId} · Skinbux #${res?.id ?? "?"}` +
          giftLine(record)
      ).catch(() => {});
      return saved;
    } catch (err) {
      if (err.definite) {
        update(record.id, { status: "failed", error: err.message, skinbuxCode: err.skinbuxCode });
        if (err.skinbuxCode === 8) {
          notify(`⚠️ Покупка с сайта не прошла: на балансе Skinbux не хватает денег (${record.name}, $${(record.skinbuxCents / 100).toFixed(2)})`).catch(() => {});
          throw new BuyError("SHOP_UNAVAILABLE", "merchant balance");
        }
        if (err.skinbuxCode === 7 || err.skinbuxCode === 11) throw new BuyError("ITEM_GONE", err.message);
        if (err.skinbuxCode === 10) throw new BuyError("PRICE_CHANGED", err.message, { price: null });
        if (err.skinbuxCode === 6) throw new BuyError("NO_TRADE_URL", err.message);
        throw new BuyError("FAILED", err.message);
      }
      // Мережа: невідомо, чи купилось. Гроші тримаємо, sync() розбереться.
      update(record.id, { status: "unknown", error: err.message });
      notify(`⚠️ Покупка с сайта: Skinbux не ответил (${record.name}). Проверю статус сам — ${err.message}`).catch(() => {});
      throw new BuyError("PENDING_CHECK", err.message);
    }
  });
}

// Подарунок: трейд іде не покупцю, а на чужу trade-ссылку.
function giftLine(p) {
  return p.recipientSteamId ? `\n🎁 В подарок: ${p.recipientName ? `${p.recipientName} · ` : ""}Steam ID ${p.recipientSteamId}` : "";
}

// ---- Наші власні скіни (ownSkins.js) ----
// Та сама покупка за баланс, але трейд шле власник сам: запис kind "own",
// status pending (чекає відправки) -> sent (власник натиснув "Відправив")
// -> completed ("Отримано", угода в трекері стає проданою) або refunded
// ("Скасувати": гроші клієнту назад, предмет знову на вітрині).
// Живе в цьому ж файлі й під тим самим замком, що й покупки Skinbux: баланс
// у клієнта один, і дві покупки не мають витратити ту саму суму.

/** id угод із трекера, на які зараз є замовлення — з вітрини їх ховаємо. */
function reservedOwnIds() {
  return new Set(
    loadAll()
      .filter((p) => p.kind === "own" && ["pending", "sent"].includes(p.status))
      .map((p) => String(p.tradeId))
  );
}

/**
 * getOwnItem(ownId) -> предмет із вітрини (ownSkins.available) або null.
 */
function buyOwn({ steamId, tradeUrl, recipientSteamId = null, recipientName = null, ownId, expectedPrice, getBalance, getOwnItem, notify = async () => {} }) {
  return exclusive(async () => {
    if (!tradeUrl) throw new BuyError("NO_TRADE_URL", "no trade url");
    if (reservedOwnIds().has(String(ownId))) throw new BuyError("ITEM_GONE", "already ordered");
    const item = await getOwnItem(String(ownId));
    if (!item) throw new BuyError("ITEM_GONE", "not in stock");
    if (Number.isFinite(expectedPrice) && item.price > expectedPrice + 0.009) {
      throw new BuyError("PRICE_CHANGED", "price changed", { price: item.price });
    }

    const balance = getBalance(steamId);
    const fromTrade = round2(Math.min(Math.max(0, balance.trade || 0), item.price));
    const fromAvailable = round2(item.price - fromTrade);
    if (fromAvailable > round2(Math.max(0, balance.available || 0)) + 0.001) {
      throw new BuyError("INSUFFICIENT_BALANCE", "not enough balance", {
        price: item.price,
        balance: round2(Math.max(0, balance.available || 0) + Math.max(0, balance.trade || 0)),
      });
    }

    const now = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(),
      kind: "own",
      steamId: String(steamId),
      tradeId: String(ownId),
      name: item.marketHashName,
      float: item.float,
      delivery: "p2p",
      price: item.price,
      paid: { trade: fromTrade, available: fromAvailable },
      tradeUrl,
      ...(recipientSteamId ? { recipientSteamId: String(recipientSteamId), recipientName } : {}),
      locked: item.locked,
      unlockAt: item.unlockAt,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    const all = loadAll();
    all.push(record);
    saveAll(all);
    const when = item.locked ? `после трейдлока (${new Date(item.unlockAt).toLocaleString("ru-RU", { timeZone: "Europe/Kyiv" })})` : "сейчас";
    notify(
      `🛒 Купили НАШ скин: ${record.name}${record.float != null ? ` (float ${Number(record.float).toFixed(6)})` : ""} — $${record.price.toFixed(2)}\n` +
        `Отправить ${when} на trade-ссылку:\n${tradeUrl}\n` +
        (record.recipientSteamId ? `${giftLine(record).trim()} — трейд шлём получателю, не покупателю.\n` : "") +
        `Steam ID ${record.steamId}. После отправки отметь в My Trades → Site orders.`
    ).catch(() => {});
    return record;
  });
}

/**
 * Дія власника над замовленням нашого скіна.
 * action: "sent" | "done" | "cancel". onDone(record) — позначити угоду в
 * трекері проданою (server.js, trades.sellTrade).
 */
function ownOrderAction(id, action, { onDone = () => {} } = {}) {
  const all = loadAll();
  const p = all.find((x) => x.id === id && x.kind === "own");
  if (!p) throw new BuyError("NOT_FOUND", "order not found");
  const allowed = {
    sent: ["pending"],
    done: ["pending", "sent"],
    cancel: ["pending", "sent"],
  }[action];
  if (!allowed) throw new BuyError("BAD_ACTION", action);
  if (!allowed.includes(p.status)) throw new BuyError("BAD_STATE", `order is ${p.status}`);
  if (action === "done") onDone(p);
  p.status = { sent: "sent", done: "completed", cancel: "refunded" }[action];
  p.updatedAt = new Date().toISOString();
  if (action === "sent") p.sentAt = p.updatedAt;
  saveAll(all);
  return p;
}

function listOwnOrders() {
  return loadAll()
    .filter((p) => p.kind === "own")
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function getStatus(apiKey, p) {
  const url = p.skinbuxId != null ? `${BASE}/transaction/status/${p.skinbuxId}` : `${BASE}/transaction/status/external/gm-${p.id}`;
  const res = await fetch(url, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => null);
  if (res.status === 404) return null;
  if (!res.ok || !data?.success) throw new Error(data?.error?.message || `Skinbux ${res.status}`);
  return data.data;
}

/** Оновити статуси незавершених покупок. Повертає кількість змін. */
async function sync({ notify = async () => {} } = {}) {
  const apiKey = process.env.SKINBUX_API_KEY;
  if (!apiKey) return 0;
  let changed = 0;
  for (const p of loadAll()) {
    if (p.kind === "own") continue; // наші скіни: статус ставить власник
    if (!["sent", "unknown"].includes(p.status) && !(p.status === "completed" && !p.finalized)) continue;
    // Завершені, але ще не фінальні (могли відкотити трейд), перевіряємо
    // не довше 10 днів.
    if (p.status === "completed" && Date.now() - new Date(p.createdAt) > 10 * 86400000) continue;
    let st;
    try {
      st = await getStatus(apiKey, p);
    } catch (err) {
      console.error(`[skinbux-buy] статус ${p.id}: ${err.message}`);
      continue;
    }
    if (!st) {
      if (p.status === "unknown" && Date.now() - new Date(p.createdAt) > UNKNOWN_GIVE_UP_MS) {
        update(p.id, { status: "failed", error: "Skinbux не знает такой транзакции" });
        notify(`↩️ Покупка ${p.name} не состоялась (Skinbux её не создал) — деньги клиенту вернулись на баланс`).catch(() => {});
        changed++;
      }
      continue;
    }
    const raw = st.status || st.overall?.status;
    let next = p.status;
    if (REFUND_STATUSES.has(raw)) next = "refunded";
    else if (raw === "completed") next = "completed";
    else if (raw === "mixed") next = "mixed";
    else if (p.status === "unknown") next = "sent";
    const patch = { skinbuxStatus: raw, steamTradeId: st.steamTradeId ?? p.steamTradeId ?? null, finalized: !!st.finalized };
    if (st.id != null && p.skinbuxId == null) patch.skinbuxId = st.id;
    if (next !== p.status) {
      patch.status = next;
      changed++;
      if (next === "refunded") {
        notify(`↩️ Трейд не состоялся (${raw}): ${p.name} — $${p.price.toFixed(2)} вернулись клиенту ${p.steamId} на баланс`).catch(() => {});
      }
      if (next === "mixed") notify(`⚠️ Покупка ${p.name}: Skinbux вернул статус mixed — проверь руками`).catch(() => {});
    }
    update(p.id, patch);
  }
  return changed;
}

/**
 * Скільки (у центах Skinbux) пішло з нашого мерчант-балансу на покупки,
 * створені між from і to. Повернуті й невдалі не рахуємо: гроші за них
 * повернулись. Для звірки поповнень (cryptoTopups.js).
 */
function spentCentsBetween(fromIso, toIso) {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  let sum = 0;
  for (const p of loadAll()) {
    const t = new Date(p.createdAt).getTime();
    // Наші скіни з балансу Skinbux грошей не беруть.
    if (p.kind === "own" || t < from || t > to || !SPENT.has(p.status)) continue;
    sum += p.skinbuxCents || 0;
  }
  return sum;
}

/** Для панелі: витрачене на покупки по всіх клієнтах. */
function totalsBySteamId() {
  const out = {};
  for (const p of loadAll()) {
    if (!SPENT.has(p.status)) continue;
    out[p.steamId] = round2((out[p.steamId] || 0) + p.price);
  }
  return out;
}

module.exports = {
  // Спільний замок для всього, що витрачає баланс клієнта (покупки, вивід —
  // cryptoPayouts.js): інакше дві дії могли б витратити ту саму суму.
  exclusive,
  buy,
  buyOwn,
  ownOrderAction,
  listOwnOrders,
  reservedOwnIds,
  sync,
  spentFor,
  applyTo,
  listByUser,
  totalsBySteamId,
  spentCentsBetween,
  BuyError,
  SPENT,
};
