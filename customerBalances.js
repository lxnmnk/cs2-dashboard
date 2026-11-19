// Ручные поправки к балансу клиента (skinbuxSales.computeBalance).
//
// Баланс в кабинете считается из журнала продаж: что клиент продал, то мы ему
// и должны, минус отметки "выплачено". Журнал знает не всё:
//   * выплатил частями — отметка paidAt закрывает всю сделку целиком;
//   * доплатил бонус (промокод, компенсация за долгий трейд, подарок);
//   * клиент продал мимо сайта, а рассчитываемся через кабинет;
//   * ошиблись в цене и договорились о другой сумме.
// Во всех этих случаях число в кабинете расходится с тем, что человек реально
// получит, и спорить с ним нечем. Здесь лежат поправки по Steam ID.
//
// Это журнал записей, а не одно число: каждая поправка со своей суммой,
// заметкой и датой, и любую можно удалить. С одним числом через месяц не
// вспомнить, почему у человека на 40 долларов больше.
//
// Поправка НЕ попадает в банк капитала (capitalBank.js): банк считает долги
// клиентам из холда Skinbux, и подмешивать туда ручные суммы — значит снова
// разойтись с вкладкой My Trades. Если выдал клиенту деньги или скин из
// своего кармана, это отдельная запись в "Owed to me" (debts.js).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FILE = path.join(__dirname, "customerBalances.json");

// Куда ложится поправка. Те же три кошелька, что видит клиент в профиле:
// available — можно выводить, hold — ждёт 7 дней, trade — только на обмен.
const BUCKETS = new Set(["available", "hold", "trade"]);

function loadAll() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function saveAll(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Steam ID 64 — ровно 17 цифр. Проверяем: опечатка в одной цифре даёт
// поправку "в никуда", и найти её потом неоткуда.
function normalizeSteamId(steamId) {
  const id = String(steamId || "").trim();
  if (!/^\d{17}$/.test(id)) throw new Error("Steam ID — 17 цифр (напр. 76561198000000000)");
  return id;
}

/** Поправки одного клиента, свежие сверху. */
function listFor(steamId) {
  const all = loadAll();
  const entries = all[String(steamId || "").trim()] || [];
  return [...entries].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/** Все клиенты, у которых есть хоть одна поправка. */
function steamIds() {
  return Object.keys(loadAll()).filter((id) => (loadAll()[id] || []).length);
}

/**
 * Добавить поправку. amount со знаком: плюс — мы должны больше, минус —
 * меньше (например, часть уже отдали наличными).
 */
//
// Холд з датою виходу (releaseDays): напр. власник продав скін клієнта сам
// через свій мерчант — ставить клієнту +$X у hold на 7 днів. Після releaseAt
// сума рахується як available, а з autoPayout сайт сам виплачує її в крипті
// на останні реквізити клієнта (cryptoPayouts.runHoldReleases).
function add({ steamId, amount, bucket = "available", note, by, releaseDays, autoPayout }) {
  const id = normalizeSteamId(steamId);
  const value = Number(amount);
  if (!Number.isFinite(value) || value === 0) throw new Error("Сумма — число, не ноль (минус уменьшает баланс)");
  if (Math.abs(value) > 100000) throw new Error("Сумма слишком большая — проверь, не опечатка ли");
  if (!BUCKETS.has(bucket)) throw new Error("Неизвестный кошелёк");

  let releaseAt = null;
  if (bucket === "hold" && releaseDays != null && releaseDays !== "") {
    const days = Number(releaseDays);
    if (!Number.isFinite(days) || days < 0 || days > 60) throw new Error("Дней холда — от 0 до 60");
    if (value <= 0) throw new Error("Холд с датой выхода — только плюсовая сумма");
    releaseAt = new Date(Date.now() + days * 86400000).toISOString();
  }

  const all = loadAll();
  if (!all[id]) all[id] = [];
  const entry = {
    id: crypto.randomUUID(),
    amount: round2(value),
    bucket,
    note: String(note || "").slice(0, 200),
    by: by || null,
    createdAt: new Date().toISOString(),
  };
  if (releaseAt) {
    entry.releaseAt = releaseAt;
    if (autoPayout) entry.autoPayout = { status: "waiting" };
  }
  all[id].push(entry);
  saveAll(all);
  return entry;
}

function remove(steamId, entryId) {
  const id = String(steamId || "").trim();
  const all = loadAll();
  const entries = all[id] || [];
  const entry = entries.find((e) => e.id === entryId);
  if (!entry) throw new Error("Поправка не найдена");
  all[id] = entries.filter((e) => e.id !== entryId);
  if (!all[id].length) delete all[id];
  saveAll(all);
  return entry;
}

/** Холд із датою, яка вже настала, — це вже "доступно". */
function effectiveBucket(entry, now = Date.now()) {
  if (entry.bucket === "hold" && entry.releaseAt && new Date(entry.releaseAt).getTime() <= now) return "available";
  return entry.bucket;
}

/** Сумма поправок клиента по кошелькам. */
function totalsFor(steamId) {
  const totals = { available: 0, hold: 0, trade: 0 };
  const now = Date.now();
  for (const entry of listFor(steamId)) {
    const bucket = effectiveBucket(entry, now);
    if (!BUCKETS.has(bucket)) continue;
    totals[bucket] = round2(totals[bucket] + (Number(entry.amount) || 0));
  }
  return totals;
}

/** Злити patch у поправку (стан автовиплати). */
function update(steamId, entryId, patch) {
  const id = String(steamId || "").trim();
  const all = loadAll();
  const entry = (all[id] || []).find((e) => e.id === entryId);
  if (!entry) return null;
  Object.assign(entry, patch);
  saveAll(all);
  return entry;
}

/** Холди з autoPayout, які вже вийшли й чекають виплати. */
function releasedAutoPayouts(now = Date.now()) {
  const out = [];
  const all = loadAll();
  for (const [steamId, entries] of Object.entries(all)) {
    for (const e of entries || []) {
      if (e.bucket !== "hold" || !e.releaseAt || !e.autoPayout) continue;
      if (new Date(e.releaseAt).getTime() > now) continue;
      out.push({ steamId, entry: e });
    }
  }
  return out;
}

/**
 * Баланс с поправками — то, что видит клиент и то, что мы реально должны.
 * Поправки прибавляются поверх свежего расчёта, а не заменяют его: новые
 * продажи клиента считаются как обычно, поправка не "протухает".
 */
function apply(balance, steamId) {
  const adj = totalsFor(steamId);
  return {
    available: round2((balance.available || 0) + adj.available),
    hold: round2((balance.hold || 0) + adj.hold),
    trade: round2((balance.trade || 0) + adj.trade),
  };
}

module.exports = { BUCKETS, listFor, steamIds, add, remove, update, totalsFor, apply, normalizeSteamId, effectiveBucket, releasedAutoPayouts };
